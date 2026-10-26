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
  clamp,
  ceil,
  exp2,
  float,
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
  vec3,
  vec4,
} from 'three/tsl';
import {
  destroyGPUStorageAttribute,
  type GPUParticleBufferState,
  type GPUParticleLike,
} from './Particle';
import {
  enumValueCount,
  nextPowerOfTwo,
  orderedFloatNode,
  unorderedFloatBits,
  unorderedFloatNode,
  type AtomicUintStorage,
  type GPUReadbackRenderer,
  type GPUStorageBufferRenderer,
  type PackedFloatStorage,
  type PackedIntStorage,
  type ScalarUintStorage,
} from './Storage';

const EMPTY_LINK = 0;
enum BoundsReduction {
  MinimumX,
  MinimumY,
  MinimumZ,
  MaximumX,
  MaximumY,
  MaximumZ,
  HasParticles,
  ShrinkFrames,
  MaximumParticleRadius,
  MaximumParticleSpeed,
}
const REDUCTION_WORDS = enumValueCount(BoundsReduction);
const DEFAULT_BOUNDS = new THREE.Box3(
  new THREE.Vector3(-0.5, -0.5, -0.5),
  new THREE.Vector3(0.5, 0.5, 0.5),
);

export interface ParticleSpatialGridOptions {
  /** Simulation-space bounds used to map positions to cells. */
  bounds: THREE.Box3;
  /** Coarse hash subdivisions per axis, expressed as a power-of-two depth. */
  brickSubdivisions: number;
  /** Fine cell subdivisions inside each brick, expressed as a power-of-two depth. */
  cellSubdivisions: number;
  /** Expands normalized bounds to stable powers of two. Defaults to true. */
  powerOfTwoBounds: boolean;
  /** Expands each axis to a shared side length. Defaults to false. */
  cubicBounds: boolean;
  /** Keeps normalized bounds centered on the simulation origin. Defaults to true. */
  centeredAtOrigin: boolean;
  /** Expands GPU bounds when live particles approach the configured volume. Defaults to true. */
  autoExpand: boolean;
  /** Shrinks an oversized power-of-two volume after a stable delay. Defaults to true. */
  autoShrink: boolean;
  /** Stable frames required before automatic shrinking. Defaults to 600. */
  shrinkDelay: number;
  /** Fractional padding added when automatic expansion occurs. Defaults to 0.125. */
  expansionHysteresis: number;
  /** Rebuild frequency from greater than zero through one. Defaults to one. */
  timeQuality: number;
  /** Zero means exact, unbounded traversal. A positive value explicitly truncates each query. */
  maxQuerySteps: number;
}

export interface ParticleSpatialGridQueryOptions {
  /** Particle slot omitted from the query, normally the caller's own slot. */
  excludeIndex?: Node<'uint'>;
  /** Bit mask requiring at least one matching particle tag. */
  tagMask?: number;
}

export type ParticleSpatialGridVisitor = (
  /** Shader-node view of a matching particle. */
  particle: GPUParticleLike,
  /** Squared simulation-space distance from the query center. */
  distanceSquared: Node<'float'>,
) => void;

export type ParticleSpatialGridParticleVisitor = (particle: GPUParticleLike) => void;

export interface ParticleSpatialGridRenderer extends GPUStorageBufferRenderer, GPUReadbackRenderer {
  compute(node: ComputeNode): void;
}

/** Optional production profiling data used to detect hash saturation and long chains. */
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
  private links?: ScalarUintStorage;
  private coordinates?: PackedIntStorage;
  private gpuBounds?: PackedFloatStorage;
  private reductions?: AtomicUintStorage;
  private diagnostics?: AtomicUintStorage;

  /** Creates a sparse grid whose storage grows with particle capacity, not world volume. */
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

  /**
   * Changes bounds and invalidates assignments. This remains a method to mirror
   * ParticleOctree.setBounds and to make the deferred GPU rebuild explicit.
   */
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
            If(encoded.equal(uint(EMPTY_LINK)), () => { Break(); });
            const slot = encoded.sub(1).toVar('spatialGridSlot');
            If(slot.greaterThanEqual(uint(this.capacity)), () => { Break(); });

            const record = this.coordinates!.element(slot);
            const exactCell = record.x.equal(coordinate.x)
              .and(record.y.equal(coordinate.y))
              .and(record.z.equal(coordinate.z));
            const particle = this.currentBuffers!.storage.createParticle(slot, true);
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
      if (head === EMPTY_LINK) return;
      nonEmptyBuckets += 1;
      let encoded = head;
      let chainLength = 0;
      while (encoded !== EMPTY_LINK && chainLength <= this.capacity) {
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
    if (values[BoundsReduction.HasParticles] === 0) {
      return { bounds: new THREE.Box3(), maxParticleSpeed: 0 };
    }
    const radius = unorderedFloatBits(values[BoundsReduction.MaximumParticleRadius]);
    return {
      bounds: new THREE.Box3(
        new THREE.Vector3(
          unorderedFloatBits(values[BoundsReduction.MinimumX]) - radius,
          unorderedFloatBits(values[BoundsReduction.MinimumY]) - radius,
          unorderedFloatBits(values[BoundsReduction.MinimumZ]) - radius,
        ),
        new THREE.Vector3(
          unorderedFloatBits(values[BoundsReduction.MaximumX]) + radius,
          unorderedFloatBits(values[BoundsReduction.MaximumY]) + radius,
          unorderedFloatBits(values[BoundsReduction.MaximumZ]) + radius,
        ),
      ),
      maxParticleSpeed: Math.max(
        0,
        unorderedFloatBits(values[BoundsReduction.MaximumParticleSpeed]),
      ),
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
    this.links = storage(this.linkAttribute, 'uint', this.capacity) as ScalarUintStorage;
    this.coordinates = storage(this.coordinateAttribute, 'ivec4', this.capacity) as PackedIntStorage;
    this.gpuBounds = storage(this.boundsAttribute, 'vec4', 2) as PackedFloatStorage;
    this.reductions = storage(this.reductionAttribute, 'uint', REDUCTION_WORDS).toAtomic() as AtomicUintStorage;
    this.diagnostics = storage(this.diagnosticAttribute, 'uint', 1).toAtomic() as AtomicUintStorage;
  }

  private getBuildNodes(buffers: GPUParticleBufferState): ComputeNode[] {
    this.currentBuffers = buffers;
    const reset = Fn(() => {
      If(instanceIndex.lessThan(uint(this.hashCapacity)), () => {
        atomicStore(this.heads!.element(instanceIndex), uint(EMPTY_LINK));
      });
      If(instanceIndex.lessThan(uint(REDUCTION_WORDS)), () => {
        If(instanceIndex.lessThan(uint(7)), () => {
          const initial = instanceIndex.lessThan(uint(3)).select(uint(0xffffffff), uint(0));
          atomicStore(this.reductions!.element(instanceIndex), initial);
        });
        If(instanceIndex.equal(uint(BoundsReduction.MaximumParticleRadius)), () => {
          atomicStore(this.reductions!.element(BoundsReduction.MaximumParticleRadius), uint(0));
        });
        If(instanceIndex.equal(uint(BoundsReduction.MaximumParticleSpeed)), () => {
          atomicStore(this.reductions!.element(BoundsReduction.MaximumParticleSpeed), uint(0));
        });
      });
      If(instanceIndex.equal(uint(0)), () => {
        atomicStore(this.diagnostics!.element(0), uint(0));
      });
    })().compute(Math.max(this.hashCapacity, REDUCTION_WORDS));

    const reduce = Fn(() => {
      const particle = buffers.storage.createParticle(undefined, true);
      If(particle.alive.notEqual(uint(0)), () => {
        atomicMin(this.reductions!.element(BoundsReduction.MinimumX), orderedFloatNode(particle.position.x));
        atomicMin(this.reductions!.element(BoundsReduction.MinimumY), orderedFloatNode(particle.position.y));
        atomicMin(this.reductions!.element(BoundsReduction.MinimumZ), orderedFloatNode(particle.position.z));
        atomicMax(this.reductions!.element(BoundsReduction.MaximumX), orderedFloatNode(particle.position.x));
        atomicMax(this.reductions!.element(BoundsReduction.MaximumY), orderedFloatNode(particle.position.y));
        atomicMax(this.reductions!.element(BoundsReduction.MaximumZ), orderedFloatNode(particle.position.z));
        atomicStore(this.reductions!.element(BoundsReduction.HasParticles), uint(1));
        const radius = max(
          particle.scale.x.abs(),
          max(particle.scale.y.abs(), particle.scale.z.abs()),
        ).mul(0.5);
        atomicMax(
          this.reductions!.element(BoundsReduction.MaximumParticleRadius),
          orderedFloatNode(radius),
        );
        atomicMax(
          this.reductions!.element(BoundsReduction.MaximumParticleSpeed),
          orderedFloatNode(particle.velocity.length()),
        );
      });
    })().compute(buffers.count);

    const finalize = Fn(() => {
      const maxParticleRadius = unorderedFloatNode(atomicLoad(
        this.reductions!.element(BoundsReduction.MaximumParticleRadius),
      ));
      if (!this.autoExpand) return;
      If(atomicLoad(this.reductions!.element(BoundsReduction.HasParticles)).notEqual(uint(0)), () => {
        const previousMin = vec3(this.gpuBounds!.element(0).xyz);
        const previousMax = vec3(this.gpuBounds!.element(1).xyz);
        const reducedMin = vec3(
          unorderedFloatNode(atomicLoad(this.reductions!.element(BoundsReduction.MinimumX))),
          unorderedFloatNode(atomicLoad(this.reductions!.element(BoundsReduction.MinimumY))),
          unorderedFloatNode(atomicLoad(this.reductions!.element(BoundsReduction.MinimumZ))),
        );
        const reducedMax = vec3(
          unorderedFloatNode(atomicLoad(this.reductions!.element(BoundsReduction.MaximumX))),
          unorderedFloatNode(atomicLoad(this.reductions!.element(BoundsReduction.MaximumY))),
          unorderedFloatNode(atomicLoad(this.reductions!.element(BoundsReduction.MaximumZ))),
        );
        const expansionMargin = previousMax.sub(previousMin).mul(this.expansionHysteresis);
        const outside = reducedMin.lessThan(previousMin.add(expansionMargin)).any()
          .or(reducedMax.greaterThan(previousMax.sub(expansionMargin)).any());
        If(outside, () => {
          if (this.autoShrink) {
            atomicStore(this.reductions!.element(BoundsReduction.ShrinkFrames), uint(0));
          }
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
              const frames = atomicFunc(
                'atomicAdd',
                this.reductions!.element(BoundsReduction.ShrinkFrames),
                uint(1),
              );
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
                atomicStore(this.reductions!.element(BoundsReduction.ShrinkFrames), uint(0));
              });
            }).Else(() => {
              atomicStore(this.reductions!.element(BoundsReduction.ShrinkFrames), uint(0));
            });
          });
        }
      });
    })().compute(1);

    const finalizeRadius = Fn(() => {
      const boundsMin = this.gpuBounds!.element(0);
      this.gpuBounds!.element(0).assign(vec4(
        boundsMin.xyz,
        unorderedFloatNode(atomicLoad(
          this.reductions!.element(BoundsReduction.MaximumParticleRadius),
        )),
      ));
    })().compute(1);

    const insert = Fn(() => {
      const particle = buffers.storage.createParticle(undefined, true);
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

/** Grid subdivision depths are bounded to avoid impractical coordinate ranges. */
function clampDepth(value: number): number {
  return THREE.MathUtils.clamp(Math.floor(value), 0, 10);
}
function nextBoundsPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(value, Number.EPSILON)) - 1e-6);
}
