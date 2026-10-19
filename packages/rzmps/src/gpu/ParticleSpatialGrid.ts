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
const REDUCTION_WORDS = 7;
const DEFAULT_BOUNDS = new THREE.Box3(
  new THREE.Vector3(-0.5, -0.5, -0.5),
  new THREE.Vector3(0.5, 0.5, 0.5),
);

export interface ParticleSpatialGridOptions {
  bounds: THREE.Box3;
  brickSubdivisions: number;
  cellSubdivisions: number;
  powerOfTwoBounds: boolean;
  autoExpand: boolean;
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

export interface ParticleSpatialGridRenderer extends GPUStorageBufferRenderer {
  compute(node: ComputeNode): void;
}

export interface ParticleSpatialGridDiagnostics {
  bounds: THREE.Box3;
  nonEmptyBuckets: number;
  referencedSlots: number;
  maxChainLength: number;
  sampleCoordinates: number[][];
}

/**
 * Sparse GPU particle spatial hash. The logical brick/cell resolution is fixed;
 * storage scales with particle capacity rather than world volume.
 */
export default class ParticleSpatialGrid {
  readonly bounds: THREE.Box3;
  readonly brickSubdivisions: number;
  readonly cellSubdivisions: number;
  readonly powerOfTwoBounds: boolean;
  readonly autoExpand: boolean;
  readonly expansionHysteresis: number;
  readonly timeQuality: number;
  readonly maxQuerySteps: number;

  readonly cellsPerAxis: number;
  readonly maxDepth: number;

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
    this.brickSubdivisions = clampDepth(options.brickSubdivisions ?? 3);
    this.cellSubdivisions = clampDepth(options.cellSubdivisions ?? 4);
    this.maxDepth = this.brickSubdivisions + this.cellSubdivisions;
    this.cellsPerAxis = 2 ** this.maxDepth;
    this.powerOfTwoBounds = options.powerOfTwoBounds ?? true;
    this.bounds = ParticleSpatialGrid.normalizeBounds(
      options.bounds ?? DEFAULT_BOUNDS,
      this.powerOfTwoBounds,
    );
    this.autoExpand = options.autoExpand ?? true;
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

  static normalizeBounds(bounds: THREE.Box3, powerOfTwo: boolean): THREE.Box3 {
    const result = bounds.clone();
    if (!powerOfTwo) return result;
    const center = result.getCenter(new THREE.Vector3());
    const size = result.getSize(new THREE.Vector3());
    size.set(
      nextPowerOfTwo(size.x),
      nextPowerOfTwo(size.y),
      nextPowerOfTwo(size.z),
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
        const initial = instanceIndex.lessThan(uint(3)).select(uint(0xffffffff), uint(0));
        atomicStore(this.reductions!.element(instanceIndex), initial);
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
      });
    })().compute(buffers.count);

    const finalize = Fn(() => {
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
        const outside = reducedMin.lessThan(previousMin).any()
          .or(reducedMax.greaterThan(previousMax).any());
        If(outside, () => {
          const wantedMin = vec3(min(previousMin, reducedMin));
          const wantedMax = vec3(max(previousMax, reducedMax));
          const padding = vec3(wantedMax.sub(wantedMin).mul(this.expansionHysteresis));
          const expandedMin = vec3(wantedMin.sub(padding)).toVar('spatialGridExpandedMin');
          const expandedMax = vec3(wantedMax.add(padding)).toVar('spatialGridExpandedMax');
          if (this.powerOfTwoBounds) {
            const center = vec3(expandedMin.add(expandedMax).mul(0.5));
            const size = vec3(exp2(ceil(log2(expandedMax.sub(expandedMin).max(vec3(Number.EPSILON))))));
            expandedMin.assign(center.sub(size.mul(0.5)));
            expandedMax.assign(center.add(size.mul(0.5)));
          }
          this.gpuBounds!.element(0).assign(vec4(expandedMin, 0));
          this.gpuBounds!.element(1).assign(vec4(expandedMax, 0));
        });
      });
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

    return [reset, reduce, finalize, insert];
  }

  private hashCoordinateNode(coordinate: Node<'ivec3'>): Node<'uint'> {
    return uint(coordinate.x).mul(73856093)
      .bitXor(uint(coordinate.y).mul(19349663))
      .bitXor(uint(coordinate.z).mul(83492791))
      .bitAnd(uint(this.hashCapacity - 1));
  }

  private resolveBounds(bounds: THREE.Box3): THREE.Box3 {
    const resolved = bounds.isEmpty() ? DEFAULT_BOUNDS : bounds;
    return ParticleSpatialGrid.normalizeBounds(resolved, this?.powerOfTwoBounds ?? false);
  }

  private writeInitialBounds(): void {
    if (!this.boundsAttribute) return;
    const resolved = ParticleSpatialGrid.normalizeBounds(this.bounds, this.powerOfTwoBounds);
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
