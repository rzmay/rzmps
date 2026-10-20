import * as THREE from 'three';
import { StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  Loop,
  atomicFunc,
  atomicLoad,
  atomicMax,
  atomicMin,
  atomicStore,
  bitAnd,
  bitXor,
  clamp,
  ceil,
  exp2,
  float,
  floatBitsToUint,
  floor,
  instanceIndex,
  int,
  ivec3,
  ivec4,
  log2,
  max,
  min,
  storage,
  uint,
  uintBitsToFloat,
  uvec4,
  vec3,
  vec4,
} from 'three/tsl';
import {
  destroyGPUStorageAttribute,
  type GPUParticleBufferState,
  type GPUParticleLike,
  type GPUReadbackRenderer,
  type GPUStorageBufferRenderer,
} from './Particle';

type AtomicUintStorage = { element(index: Node | number): Node<'uint'> };
type UintStorage = { element(index: Node | number): Node<'uint'> };
type Int4Storage = { element(index: Node | number): Node<'ivec4'> };
type Float4Storage = { element(index: Node | number): Node<'vec4'> };

const EMPTY = 0;
const REDUCTION_WORDS = 10;
const DEFAULT_BOUNDS = new THREE.Box3(
  new THREE.Vector3(-0.5, -0.5, -0.5),
  new THREE.Vector3(0.5, 0.5, 0.5),
);

export interface ParticleSpatialGridOptions {
  bounds: THREE.Box3;
  brickSubdivisions: number;
  cellSubdivisions: number;
  powerOfTwoBounds: boolean;
  cubicBounds: boolean;
  centeredAtOrigin: boolean;
  autoExpand: boolean;
  autoShrink: boolean;
  shrinkDelay: number;
  expansionHysteresis: number;
  timeQuality: number;
  /** Zero means exact, unbounded traversal. A positive value explicitly truncates each query. */
  maxQuerySteps: number;
}

export interface ParticleSpatialGridQueryOptions {
  excludeIndex?: Node<'uint'>;
  tagMask?: number;
}

export type ParticleSpatialGridVisitor = (
  particle: GPUParticleLike,
  distanceSquared: Node<'float'>,
) => void;

export type ParticleSpatialGridParticleVisitor = (particle: GPUParticleLike) => void;

export interface ParticleSpatialGridRenderer extends GPUStorageBufferRenderer, GPUReadbackRenderer {
  compute(node: ComputeNode): void;
}

export interface ParticleSpatialGridDiagnostics {
  bounds: THREE.Box3;
  nonEmptyBuckets: number;
  referencedSlots: number;
  maxChainLength: number;
  sampleCoordinates: number[][];
}

export interface ParticleSpatialGridMetrics {
  bounds: THREE.Box3;
  maxParticleSpeed: number;
}

/**
 * Sparse GPU particle spatial hash. The logical brick/cell resolution is fixed;
 * storage scales with particle capacity rather than world volume.
 */
export default class ParticleSpatialGrid {
  readonly bounds: THREE.Box3;
  powerOfTwoBounds: boolean;
  cubicBounds: boolean;
  centeredAtOrigin: boolean;
  autoExpand: boolean;
  autoShrink: boolean;
  shrinkDelay: number;
  expansionHysteresis: number;
  timeQuality: number;
  maxQuerySteps: number;

  get resourceVersion(): number { return this.version; }

  private _brickSubdivisions = 3;
  private _cellSubdivisions = 4;

  get brickSubdivisions(): number { return this._brickSubdivisions; }
  set brickSubdivisions(value: number) {
    const next = clampDepth(value);
    if (next === this._brickSubdivisions) return;
    this._brickSubdivisions = next;
    this.invalidateStructure();
  }

  get cellSubdivisions(): number { return this._cellSubdivisions; }
  set cellSubdivisions(value: number) {
    const next = clampDepth(value);
    if (next === this._cellSubdivisions) return;
    this._cellSubdivisions = next;
    this.invalidateStructure();
  }

  get maxDepth(): number { return this.brickSubdivisions + this.cellSubdivisions; }
  get cellsPerAxis(): number { return 2 ** this.maxDepth; }

  private capacity = 0;
  private hashCapacity = 0;
  private version = 0;
  private updateAccumulator = 0;
  private lastBufferVersion = -1;
  private lastBuildToken: unknown;

  private headAttribute?: StorageBufferAttribute;
  private linkAttribute?: StorageBufferAttribute;
  private coordinateAttribute?: StorageBufferAttribute;
  private boundsAttribute?: StorageBufferAttribute;
  private reductionAttribute?: StorageBufferAttribute;
  private diagnosticAttribute?: StorageBufferAttribute;

  private heads?: AtomicUintStorage;
  private links?: UintStorage;
  private coordinates?: Int4Storage;
  private gpuBounds?: Float4Storage;
  private reductions?: AtomicUintStorage;
  private diagnostics?: AtomicUintStorage;

  constructor(options: Partial<ParticleSpatialGridOptions> = {}) {
    this._brickSubdivisions = clampDepth(options.brickSubdivisions ?? 3);
    this._cellSubdivisions = clampDepth(options.cellSubdivisions ?? 4);
    this.powerOfTwoBounds = options.powerOfTwoBounds ?? true;
    this.cubicBounds = options.cubicBounds ?? false;
    this.centeredAtOrigin = options.centeredAtOrigin ?? true;
    this.bounds = ParticleSpatialGrid.normalizeBounds(
      options.bounds ?? DEFAULT_BOUNDS,
      this.powerOfTwoBounds,
      this.cubicBounds,
      this.centeredAtOrigin,
    );
    this.autoExpand = options.autoExpand ?? true;
    this.autoShrink = options.autoShrink ?? true;
    this.shrinkDelay = Math.max(1, Math.floor(options.shrinkDelay ?? 600));
    this.expansionHysteresis = Math.max(0, options.expansionHysteresis ?? 0.125);
    this.timeQuality = THREE.MathUtils.clamp(
      options.timeQuality ?? 1,
      Number.EPSILON,
      1,
    );
    this.maxQuerySteps = Math.max(0, Math.floor(options.maxQuerySteps ?? 0));
  }

  /** Changes the configured bounds. GPU cell assignments are rebuilt on the next update. */
  setBounds(bounds?: THREE.Box3): this {
    this.bounds.copy(this.resolveBounds(bounds ?? DEFAULT_BOUNDS));
    this.lastBufferVersion = -1;
    if (this.boundsAttribute) this.writeInitialBounds();
    return this;
  }

  /** Applies grid options and rebuilds structural GPU work on the next update. */
  setOptions(options: Partial<Omit<ParticleSpatialGridOptions, 'bounds'>>): this {
    if (options.brickSubdivisions !== undefined) {
      this.brickSubdivisions = options.brickSubdivisions;
    }
    if (options.cellSubdivisions !== undefined) {
      this.cellSubdivisions = options.cellSubdivisions;
    }
    if (options.powerOfTwoBounds !== undefined) this.powerOfTwoBounds = options.powerOfTwoBounds;
    if (options.cubicBounds !== undefined) this.cubicBounds = options.cubicBounds;
    if (options.centeredAtOrigin !== undefined) this.centeredAtOrigin = options.centeredAtOrigin;
    if (options.autoExpand !== undefined) this.autoExpand = options.autoExpand;
    if (options.autoShrink !== undefined) this.autoShrink = options.autoShrink;
    if (options.shrinkDelay !== undefined) {
      this.shrinkDelay = Math.max(1, Math.floor(options.shrinkDelay));
    }
    if (options.expansionHysteresis !== undefined) {
      this.expansionHysteresis = Math.max(0, options.expansionHysteresis);
    }
    if (options.timeQuality !== undefined) {
      this.timeQuality = THREE.MathUtils.clamp(options.timeQuality, Number.EPSILON, 1);
    }
    if (options.maxQuerySteps !== undefined) {
      this.maxQuerySteps = Math.max(0, Math.floor(options.maxQuerySteps));
    }
    this.bounds.copy(this.resolveBounds(this.bounds));
    this.lastBufferVersion = -1;
    this.version += 1;
    if (this.boundsAttribute) this.writeInitialBounds();
    return this;
  }

  private invalidateStructure(): void {
    this.lastBufferVersion = -1;
    this.lastBuildToken = undefined;
    this.version += 1;
  }

  /** Returns the logical cell coordinate using the currently configured CPU-side bounds. */
  locate(position: THREE.Vector3): THREE.Vector3 {
    return ParticleSpatialGrid.locate(position, this.bounds, this.cellsPerAxis);
  }

  /** Alias matching the CPU utility's rebuild terminology. */
  rebuild(
    renderer: ParticleSpatialGridRenderer,
    buffers: GPUParticleBufferState,
    buildToken?: unknown,
  ): boolean {
    this.updateAccumulator += this.timeQuality;
    if (
      this.lastBufferVersion === buffers.version
      && this.lastBuildToken === buildToken
      && this.updateAccumulator < 1
    ) return false;

    if (this.updateAccumulator >= 1) this.updateAccumulator -= 1;
    this.ensureCapacity(renderer, buffers.capacity);
    this.lastBufferVersion = buffers.version;
    this.lastBuildToken = buildToken;

    this.getBuildNodes(buffers).forEach((node) => renderer.compute(node));
    return true;
  }

  /**
   * Emits a shader-side exact-radius query. The callback receives a loaded particle
   * and may read all particle attributes. No JavaScript particle array is created.
   */
  forEachParticleInRadius(
    position: Node<'vec3'>,
    radius: Node<'float'>,
    callback: ParticleSpatialGridVisitor,
    options: ParticleSpatialGridQueryOptions = {},
  ): void {
    this.assertReady();
    const boundsMin = vec3(this.gpuBounds!.element(0).xyz);
    const boundsMax = vec3(this.gpuBounds!.element(1).xyz);
    const cellSize = vec3(boundsMax.sub(boundsMin).div(float(this.cellsPerAxis)));
    const queryMin = ivec3(clamp(
      floor(position.sub(radius).sub(boundsMin).div(cellSize)),
      vec3(0),
      vec3(this.cellsPerAxis - 1),
    ));
    const queryMax = ivec3(clamp(
      floor(position.add(radius).sub(boundsMin).div(cellSize)),
      vec3(0),
      vec3(this.cellsPerAxis - 1),
    ));
    const radiusSquared = float(radius.mul(radius));
    const visited = uint(0).toVar('spatialGridVisited');

    Loop(
      { start: queryMin.x, end: queryMax.x.add(1) },
      { start: queryMin.y, end: queryMax.y.add(1) },
      ({ i: gridX, j: gridY }) => {
        const gridZ = int(queryMin.z).toVar('spatialGridZ');
        Loop(() => {
          If(gridZ.greaterThan(queryMax.z), () => { Break(); });
          if (this.maxQuerySteps > 0) {
            If(visited.greaterThanEqual(uint(this.maxQuerySteps)), () => { Break(); });
          }
          const coordinate = ivec3(int(gridX), int(gridY), int(gridZ));
          const bucket = this.hashCoordinateNode(coordinate);
          const encoded = atomicLoad(this.heads!.element(bucket)).toVar('spatialGridLink');

          Loop(() => {
            If(encoded.equal(uint(EMPTY)), () => { Break(); });
            const slot = encoded.sub(1).toVar('spatialGridSlot');
            If(slot.greaterThanEqual(uint(this.capacity)), () => { Break(); });

            const record = this.coordinates!.element(slot);
            const exactCell = record.x.equal(coordinate.x)
              .and(record.y.equal(coordinate.y))
              .and(record.z.equal(coordinate.z));
            const particle = this.currentBuffers!.storage.loadParticle(slot);
            const currentGeneration = uint(record.w);
            const acceptedTag = options.tagMask === undefined
              ? particle.alive.notEqual(uint(0))
              : particle.alive.notEqual(uint(0))
                .and(particle.tagMask.bitAnd(uint(options.tagMask)).notEqual(uint(0)));
            const notSelf = options.excludeIndex === undefined
              ? acceptedTag
              : acceptedTag.and(slot.notEqual(options.excludeIndex));
            const offset = vec3(particle.position.sub(position));
            const distanceSquared = float(offset.lengthSq());

            If(
              exactCell
                .and(notSelf)
                .and(particle.generation.equal(currentGeneration))
                .and(distanceSquared.lessThanEqual(radiusSquared)),
              () => callback(particle, distanceSquared),
            );

            visited.addAssign(1);
            if (this.maxQuerySteps > 0) {
              If(visited.greaterThanEqual(uint(this.maxQuerySteps)), () => {
                If(visited.equal(uint(this.maxQuerySteps)), () => {
                  atomicFunc('atomicAdd', this.diagnostics!.element(0), uint(1));
                });
                Break();
              });
            }
            encoded.assign(this.links!.element(slot));
          });
          gridZ.addAssign(1);
        });
      },
    );
  }

  /**
   * Visits every live particle in the current GPU buffer. This is primarily an
   * aggregate fallback for algorithms whose CPU counterparts can sample parent
   * octree nodes when a fine-grained neighborhood is empty.
   */
  forEachParticle(
    callback: ParticleSpatialGridParticleVisitor,
    options: ParticleSpatialGridQueryOptions = {},
  ): void {
    this.assertReady();
    Loop({ start: 0, end: this.capacity, type: 'uint' }, ({ i }) => {
      const particle = this.currentBuffers!.storage.loadParticle(i);
      const acceptedTag = options.tagMask === undefined
        ? particle.alive.notEqual(uint(0))
        : particle.alive.notEqual(uint(0))
          .and(particle.tagMask.bitAnd(uint(options.tagMask)).notEqual(uint(0)));
      const accepted = options.excludeIndex === undefined
        ? acceptedTag
        : acceptedTag.and(particle.index.notEqual(options.excludeIndex));

      If(accepted, () => callback(particle));
    });
  }

  /** Releases GPU attributes owned by this grid. Explicitly shared grids remain caller-owned. */
  dispose(renderer?: GPUStorageBufferRenderer): void {
    [
      this.headAttribute,
      this.linkAttribute,
      this.coordinateAttribute,
      this.boundsAttribute,
      this.reductionAttribute,
      this.diagnosticAttribute,
    ].forEach((attribute) => {
      if (attribute) destroyGPUStorageAttribute(renderer, attribute);
    });
    this.capacity = 0;
    this.hashCapacity = 0;
    this.headAttribute = undefined;
    this.linkAttribute = undefined;
    this.coordinateAttribute = undefined;
    this.boundsAttribute = undefined;
    this.reductionAttribute = undefined;
    this.diagnosticAttribute = undefined;
    this.heads = undefined;
    this.links = undefined;
    this.coordinates = undefined;
    this.gpuBounds = undefined;
    this.reductions = undefined;
    this.diagnostics = undefined;
    this.currentBuffers = undefined;
  }

  destroy(renderer?: GPUStorageBufferRenderer): void {
    this.dispose(renderer);
  }

  /** Reads hash metadata for validation and profiling without reading particle state. */
  async readDiagnostics(renderer: GPUReadbackRenderer): Promise<ParticleSpatialGridDiagnostics> {
    if (
      !this.headAttribute
      || !this.linkAttribute
      || !this.coordinateAttribute
      || !this.boundsAttribute
    ) {
      throw new Error('ParticleSpatialGrid must be rebuilt before reading diagnostics.');
    }

    const [headBuffer, linkBuffer, coordinateBuffer, boundsBuffer] = await Promise.all([
      renderer.getArrayBufferAsync(this.headAttribute),
      renderer.getArrayBufferAsync(this.linkAttribute),
      renderer.getArrayBufferAsync(this.coordinateAttribute),
      renderer.getArrayBufferAsync(this.boundsAttribute),
    ]);
    const heads = new Uint32Array(headBuffer);
    const links = new Uint32Array(linkBuffer);
    const coordinates = new Int32Array(coordinateBuffer);
    const bounds = new Float32Array(boundsBuffer);
    const referenced = new Set<number>();
    let nonEmptyBuckets = 0;
    let maxChainLength = 0;

    heads.forEach((head) => {
      if (head === EMPTY) return;
      nonEmptyBuckets += 1;
      let encoded = head;
      let chainLength = 0;
      while (encoded !== EMPTY && chainLength <= this.capacity) {
        const slot = encoded - 1;
        if (slot >= this.capacity) break;
        referenced.add(slot);
        chainLength += 1;
        encoded = links[slot];
      }
      maxChainLength = Math.max(maxChainLength, chainLength);
    });

    return {
      bounds: new THREE.Box3(
        new THREE.Vector3(bounds[0], bounds[1], bounds[2]),
        new THREE.Vector3(bounds[4], bounds[5], bounds[6]),
      ),
      nonEmptyBuckets,
      referencedSlots: referenced.size,
      maxChainLength,
      sampleCoordinates: Array.from(referenced).slice(0, 8).map((slot) => (
        Array.from(coordinates.subarray(slot * 4, slot * 4 + 4))
      )),
    };
  }

  /** Reads only the eight floats needed by a dense GPU field following this grid. */
  async readBounds(renderer: GPUReadbackRenderer): Promise<THREE.Box3> {
    if (!this.boundsAttribute) throw new Error('ParticleSpatialGrid must be rebuilt before reading bounds.');
    const values = new Float32Array(await renderer.getArrayBufferAsync(this.boundsAttribute));
    return new THREE.Box3(
      new THREE.Vector3(values[0], values[1], values[2]),
      new THREE.Vector3(values[4], values[5], values[6]),
    );
  }

  /** Reads the live GPU particle bounds, expanded by the largest particle radius. */
  async readParticleBounds(renderer: GPUReadbackRenderer): Promise<THREE.Box3> {
    return (await this.readParticleMetrics(renderer)).bounds;
  }

  /** Reads live particle bounds and motion metrics with one GPU transfer. */
  async readParticleMetrics(renderer: GPUReadbackRenderer): Promise<ParticleSpatialGridMetrics> {
    if (!this.reductionAttribute) throw new Error('ParticleSpatialGrid must be rebuilt before reading particle bounds.');
    const values = new Uint32Array(await renderer.getArrayBufferAsync(this.reductionAttribute));
    if (values[6] === 0) return { bounds: new THREE.Box3(), maxParticleSpeed: 0 };
    const radius = decodeOrderedFloat(values[8]);
    return {
      bounds: new THREE.Box3(
        new THREE.Vector3(
          decodeOrderedFloat(values[0]) - radius,
          decodeOrderedFloat(values[1]) - radius,
          decodeOrderedFloat(values[2]) - radius,
        ),
        new THREE.Vector3(
          decodeOrderedFloat(values[3]) + radius,
          decodeOrderedFloat(values[4]) + radius,
          decodeOrderedFloat(values[5]) + radius,
        ),
      ),
      maxParticleSpeed: Math.max(0, decodeOrderedFloat(values[9])),
    };
  }

  /** Largest speed among live particles from the current GPU reduction. */
  async readMaxParticleSpeed(renderer: GPUReadbackRenderer): Promise<number> {
    return (await this.readParticleMetrics(renderer)).maxParticleSpeed;
  }

  /** Largest live particle radius from the current GPU reduction. */
  getMaxParticleRadiusNode(): Node<'float'> {
    this.assertReady();
    return this.gpuBounds!.element(0).w as Node<'float'>;
  }

  static locate(position: THREE.Vector3, bounds: THREE.Box3, cellsPerAxis: number): THREE.Vector3 {
    const size = bounds.getSize(new THREE.Vector3());
    return new THREE.Vector3(
      Math.floor((position.x - bounds.min.x) / Math.max(size.x, Number.EPSILON) * cellsPerAxis),
      Math.floor((position.y - bounds.min.y) / Math.max(size.y, Number.EPSILON) * cellsPerAxis),
      Math.floor((position.z - bounds.min.z) / Math.max(size.z, Number.EPSILON) * cellsPerAxis),
    ).clampScalar(0, cellsPerAxis - 1);
  }

  static hashCoordinate(coordinate: THREE.Vector3, hashCapacity: number): number {
    const x = coordinate.x | 0;
    const y = coordinate.y | 0;
    const z = coordinate.z | 0;
    return (((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0)
      & (hashCapacity - 1);
  }

  static normalizeBounds(
    bounds: THREE.Box3,
    powerOfTwo: boolean,
    cubic = false,
    centeredAtOrigin = false,
  ): THREE.Box3 {
    const result = bounds.clone();
    if (!powerOfTwo && !cubic && !centeredAtOrigin) return result;
    const center = centeredAtOrigin
      ? new THREE.Vector3()
      : result.getCenter(new THREE.Vector3());
    const size = centeredAtOrigin
      ? new THREE.Vector3(
        2 * Math.max(Math.abs(result.min.x), Math.abs(result.max.x)),
        2 * Math.max(Math.abs(result.min.y), Math.abs(result.max.y)),
        2 * Math.max(Math.abs(result.min.z), Math.abs(result.max.z)),
      )
      : result.getSize(new THREE.Vector3());
    if (cubic) size.setScalar(Math.max(size.x, size.y, size.z));
    if (!powerOfTwo) return result.setFromCenterAndSize(center, size);
    size.set(
      nextBoundsPowerOfTwo(size.x),
      nextBoundsPowerOfTwo(size.y),
      nextBoundsPowerOfTwo(size.z),
    );
    return result.setFromCenterAndSize(center, size);
  }

  private currentBuffers?: GPUParticleBufferState;

  private ensureCapacity(renderer: GPUStorageBufferRenderer, capacity: number): void {
    if (capacity === this.capacity && this.headAttribute) return;
    this.dispose(renderer);
    this.capacity = Math.max(1, capacity);
    this.hashCapacity = nextPowerOfTwo(this.capacity * 2);
    this.version += 1;

    this.headAttribute = new StorageBufferAttribute(new Uint32Array(this.hashCapacity), 1);
    this.linkAttribute = new StorageBufferAttribute(new Uint32Array(this.capacity), 1);
    this.coordinateAttribute = new StorageBufferAttribute(new Int32Array(this.capacity * 4), 4);
    this.boundsAttribute = new StorageBufferAttribute(new Float32Array(8), 4);
    this.reductionAttribute = new StorageBufferAttribute(new Uint32Array(REDUCTION_WORDS), 1);
    this.diagnosticAttribute = new StorageBufferAttribute(new Uint32Array(1), 1);
    this.writeInitialBounds();

    this.heads = storage(this.headAttribute, 'uint', this.hashCapacity).toAtomic() as AtomicUintStorage;
    this.links = storage(this.linkAttribute, 'uint', this.capacity) as UintStorage;
    this.coordinates = storage(this.coordinateAttribute, 'ivec4', this.capacity) as Int4Storage;
    this.gpuBounds = storage(this.boundsAttribute, 'vec4', 2) as Float4Storage;
    this.reductions = storage(this.reductionAttribute, 'uint', REDUCTION_WORDS).toAtomic() as AtomicUintStorage;
    this.diagnostics = storage(this.diagnosticAttribute, 'uint', 1).toAtomic() as AtomicUintStorage;
  }

  private getBuildNodes(buffers: GPUParticleBufferState): ComputeNode[] {
    this.currentBuffers = buffers;
    const reset = Fn(() => {
      If(instanceIndex.lessThan(uint(this.hashCapacity)), () => {
        atomicStore(this.heads!.element(instanceIndex), uint(EMPTY));
      });
      If(instanceIndex.lessThan(uint(REDUCTION_WORDS)), () => {
        If(instanceIndex.lessThan(uint(7)), () => {
          const initial = instanceIndex.lessThan(uint(3)).select(uint(0xffffffff), uint(0));
          atomicStore(this.reductions!.element(instanceIndex), initial);
        });
        If(instanceIndex.equal(uint(8)), () => {
          atomicStore(this.reductions!.element(8), uint(0));
        });
        If(instanceIndex.equal(uint(9)), () => {
          atomicStore(this.reductions!.element(9), uint(0));
        });
      });
      If(instanceIndex.equal(uint(0)), () => {
        atomicStore(this.diagnostics!.element(0), uint(0));
      });
    })().compute(Math.max(this.hashCapacity, REDUCTION_WORDS));

    const reduce = Fn(() => {
      const particle = buffers.storage.loadParticle();
      If(particle.alive.notEqual(uint(0)), () => {
        atomicMin(this.reductions!.element(0), orderedFloat(particle.position.x));
        atomicMin(this.reductions!.element(1), orderedFloat(particle.position.y));
        atomicMin(this.reductions!.element(2), orderedFloat(particle.position.z));
        atomicMax(this.reductions!.element(3), orderedFloat(particle.position.x));
        atomicMax(this.reductions!.element(4), orderedFloat(particle.position.y));
        atomicMax(this.reductions!.element(5), orderedFloat(particle.position.z));
        atomicStore(this.reductions!.element(6), uint(1));
        const radius = max(
          particle.scale.x.abs(),
          max(particle.scale.y.abs(), particle.scale.z.abs()),
        ).mul(0.5);
        atomicMax(this.reductions!.element(8), orderedFloat(radius));
        atomicMax(this.reductions!.element(9), orderedFloat(particle.velocity.length()));
      });
    })().compute(buffers.count);

    const finalize = Fn(() => {
      const maxParticleRadius = unorderedFloat(atomicLoad(this.reductions!.element(8)));
      if (!this.autoExpand) return;
      If(atomicLoad(this.reductions!.element(6)).notEqual(uint(0)), () => {
        const previousMin = vec3(this.gpuBounds!.element(0).xyz);
        const previousMax = vec3(this.gpuBounds!.element(1).xyz);
        const reducedMin = vec3(
          unorderedFloat(atomicLoad(this.reductions!.element(0))),
          unorderedFloat(atomicLoad(this.reductions!.element(1))),
          unorderedFloat(atomicLoad(this.reductions!.element(2))),
        );
        const reducedMax = vec3(
          unorderedFloat(atomicLoad(this.reductions!.element(3))),
          unorderedFloat(atomicLoad(this.reductions!.element(4))),
          unorderedFloat(atomicLoad(this.reductions!.element(5))),
        );
        const expansionMargin = previousMax.sub(previousMin).mul(this.expansionHysteresis);
        const outside = reducedMin.lessThan(previousMin.add(expansionMargin)).any()
          .or(reducedMax.greaterThan(previousMax.sub(expansionMargin)).any());
        If(outside, () => {
          if (this.autoShrink) atomicStore(this.reductions!.element(7), uint(0));
          const currentSize = previousMax.sub(previousMin);
          const particleSize = reducedMax.sub(reducedMin).max(vec3(Number.EPSILON));
          const padding = vec3(particleSize.mul(this.expansionHysteresis).add(maxParticleRadius));
          const expandedMin = vec3(reducedMin.sub(padding)).toVar('spatialGridExpandedMin');
          const expandedMax = vec3(reducedMax.add(padding)).toVar('spatialGridExpandedMax');
          const center = this.centeredAtOrigin
            ? vec3(0)
            : vec3(expandedMin.add(expandedMax).mul(0.5));
          if (this.powerOfTwoBounds) {
            const requestedSize = this.centeredAtOrigin
              ? max(expandedMin.abs(), expandedMax.abs()).mul(2).max(vec3(Number.EPSILON))
              : expandedMax.sub(expandedMin).max(vec3(Number.EPSILON));
            if (this.cubicBounds) {
              const requestedSide = max(max(requestedSize.x, requestedSize.y), requestedSize.z);
              const currentSide = max(max(currentSize.x, currentSize.y), currentSize.z);
              const side = max(exp2(ceil(log2(requestedSide).sub(1e-6))), currentSide);
              const half = side.mul(0.5);
              const halfSize = vec3(half, half, half);
              expandedMin.assign(center.sub(halfSize));
              expandedMax.assign(center.add(halfSize));
            } else {
              const requestedPowerOfTwo = vec3(exp2(ceil(log2(requestedSize).sub(1e-6))));
              const size = max(requestedPowerOfTwo, currentSize);
              expandedMin.assign(center.sub(size.mul(0.5)));
              expandedMax.assign(center.add(size.mul(0.5)));
            }
          } else if (this.cubicBounds) {
            const requestedSize = this.centeredAtOrigin
              ? max(expandedMin.abs(), expandedMax.abs()).mul(2)
              : expandedMax.sub(expandedMin);
            const side = max(
              max(max(requestedSize.x, requestedSize.y), requestedSize.z),
              max(max(currentSize.x, currentSize.y), currentSize.z),
            );
            expandedMin.assign(center.sub(vec3(side.mul(0.5))));
            expandedMax.assign(center.add(vec3(side.mul(0.5))));
          } else {
            const requestedSize = this.centeredAtOrigin
              ? max(expandedMin.abs(), expandedMax.abs()).mul(2)
              : expandedMax.sub(expandedMin);
            const size = max(requestedSize, currentSize);
            expandedMin.assign(center.sub(size.mul(0.5)));
            expandedMax.assign(center.add(size.mul(0.5)));
          }
          this.gpuBounds!.element(0).assign(vec4(expandedMin, maxParticleRadius));
          this.gpuBounds!.element(1).assign(vec4(expandedMax, 0));
        });
        if (this.autoShrink) {
          If(outside.not(), () => {
            const currentSize = previousMax.sub(previousMin);
            const targetSize = this.centeredAtOrigin
              ? max(reducedMin.abs(), reducedMax.abs()).mul(2).max(vec3(Number.EPSILON))
              : reducedMax.sub(reducedMin).max(vec3(Number.EPSILON));
            const currentSide = max(max(currentSize.x, currentSize.y), currentSize.z);
            const targetSide = max(max(targetSize.x, targetSize.y), targetSize.z);
            const compact = targetSide.mul(1 + 2 * this.expansionHysteresis)
              .lessThan(currentSide.mul(0.45));
            If(compact, () => {
              const frames = atomicFunc('atomicAdd', this.reductions!.element(7), uint(1));
              If(frames.greaterThanEqual(uint(this.shrinkDelay - 1)), () => {
                const center = this.centeredAtOrigin
                  ? vec3(0)
                  : reducedMin.add(reducedMax).mul(0.5);
                const paddedSide = targetSide.mul(1 + 2 * this.expansionHysteresis);
                const side = this.powerOfTwoBounds
                  ? exp2(ceil(log2(paddedSide).sub(1e-6)))
                  : paddedSide;
                const half = side.mul(0.5);
                const halfSize = vec3(half, half, half);
                this.gpuBounds!.element(0).assign(vec4(center.sub(halfSize), maxParticleRadius));
                this.gpuBounds!.element(1).assign(vec4(center.add(halfSize), 0));
                atomicStore(this.reductions!.element(7), uint(0));
              });
            }).Else(() => {
              atomicStore(this.reductions!.element(7), uint(0));
            });
          });
        }
      });
    })().compute(1);

    const finalizeRadius = Fn(() => {
      const boundsMin = this.gpuBounds!.element(0);
      this.gpuBounds!.element(0).assign(vec4(
        boundsMin.xyz,
        unorderedFloat(atomicLoad(this.reductions!.element(8))),
      ));
    })().compute(1);

    const insert = Fn(() => {
      const particle = buffers.storage.loadParticle();
      If(particle.alive.notEqual(uint(0)), () => {
        const boundsMin = vec3(this.gpuBounds!.element(0).xyz);
        const boundsMax = vec3(this.gpuBounds!.element(1).xyz);
        const inside = particle.position.greaterThanEqual(boundsMin).all()
          .and(particle.position.lessThanEqual(boundsMax).all());
        If(inside, () => {
        const coordinate = ivec3(clamp(
          floor(
            particle.position.sub(boundsMin)
              .div(boundsMax.sub(boundsMin).max(vec3(Number.EPSILON)))
              .mul(float(this.cellsPerAxis)),
          ),
          vec3(0),
          vec3(this.cellsPerAxis - 1),
        ));
        const bucket = this.hashCoordinateNode(coordinate);
        const encoded = particle.index.add(uint(1));
        const previous = atomicFunc(
          'atomicExchange' as Parameters<typeof atomicFunc>[0],
          this.heads!.element(bucket),
          encoded,
        );
        this.links!.element(particle.index).assign(previous);
          this.coordinates!.element(particle.index).assign(
            ivec4(coordinate.x, coordinate.y, coordinate.z, int(particle.generation)),
          );
        });
      });
    })().compute(buffers.count);

    return [reset, reduce, finalize, finalizeRadius, insert];
  }

  private hashCoordinateNode(coordinate: Node<'ivec3'>): Node<'uint'> {
    return uint(coordinate.x).mul(73856093)
      .bitXor(uint(coordinate.y).mul(19349663))
      .bitXor(uint(coordinate.z).mul(83492791))
      .bitAnd(uint(this.hashCapacity - 1));
  }

  private resolveBounds(bounds: THREE.Box3): THREE.Box3 {
    const resolved = bounds.isEmpty() ? DEFAULT_BOUNDS : bounds;
    return ParticleSpatialGrid.normalizeBounds(
      resolved,
      this?.powerOfTwoBounds ?? false,
      this?.cubicBounds ?? false,
      this?.centeredAtOrigin ?? false,
    );
  }

  private writeInitialBounds(): void {
    if (!this.boundsAttribute) return;
    const resolved = ParticleSpatialGrid.normalizeBounds(
      this.bounds,
      this.powerOfTwoBounds,
      this.cubicBounds,
      this.centeredAtOrigin,
    );
    const array = this.boundsAttribute.array as Float32Array;
    array.set([resolved.min.x, resolved.min.y, resolved.min.z, 0], 0);
    array.set([resolved.max.x, resolved.max.y, resolved.max.z, 0], 4);
    this.boundsAttribute.needsUpdate = true;
  }

  private assertReady(): void {
    if (!this.currentBuffers || !this.heads || !this.coordinates || !this.links || !this.gpuBounds) {
      throw new Error('ParticleSpatialGrid must be rebuilt before creating query nodes.');
    }
  }
}

function clampDepth(value: number): number {
  return THREE.MathUtils.clamp(Math.floor(value), 0, 10);
}

function nextPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(value, Number.EPSILON)));
}

function nextBoundsPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(value, Number.EPSILON)) - 1e-6);
}

function orderedFloat(value: Node<'float'>): Node<'uint'> {
  const bits = floatBitsToUint(value) as unknown as Node<'uint'>;
  return bitAnd(bits, uint(0x80000000)).notEqual(uint(0))
    .select(bitXor(bits, uint(0xffffffff)), bitXor(bits, uint(0x80000000))) as Node<'uint'>;
}

function unorderedFloat(value: Node<'uint'>): Node<'float'> {
  const bits = bitAnd(value, uint(0x80000000)).notEqual(uint(0))
    .select(bitXor(value, uint(0x80000000)), bitXor(value, uint(0xffffffff)));
  return uintBitsToFloat(bits) as unknown as Node<'float'>;
}

function decodeOrderedFloat(value: number): number {
  const bits = (value & 0x80000000) !== 0
    ? (value ^ 0x80000000) >>> 0
    : (value ^ 0xffffffff) >>> 0;
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint32(0, bits, true);
  return view.getFloat32(0, true);
}
