import type { SpatialGridDomain } from './spatialGridDomain.utils';
import { SpatialBackend } from '../../enums/SpatialBackend';
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
  float,
  floor,
  instanceIndex,
  int,
  ivec3,
  ivec4,
  max,
  min,
  storage,
  uint,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import {
  destroyGPUStorageAttribute,
  type GPUParticleBufferState,
  type GPUParticleLike,
} from '../../simulation/gpu/Particle';
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
} from '../../utils/gpu/storage.utils';
import { computeRange, type GPUComputeRange } from '../../utils/gpu/computeDispatch.utils';
import { SpatialLevels, resolveSpatialLevels, type SpatialGridOptions } from '../../enums/resolveSpatialLevels';
import type { GPUSpatialRegion, SpatialAggregator, SpatialAggregateLayout } from '../../types/spatialAggregator.types';
import GPUSpatialRegions from './gpu/GPUSpatialRegions';

import SpatialGrid from './SpatialGrid';
import { boundsVector, createSpatialDomain, type SpatialGuardDepth } from './spatialGridDomain.utils';

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
  MaximumVelocityX,
  MaximumVelocityY,
  MaximumVelocityZ,
}
const REDUCTION_WORDS = enumValueCount(BoundsReduction);
const DEFAULT_BOUNDS = new THREE.Box3(
  new THREE.Vector3(-0.5, -0.5, -0.5),
  new THREE.Vector3(0.5, 0.5, 0.5),
);

export interface ParticleSpatialGridOptions extends SpatialGridOptions {
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
  /** Legacy explicit-domain normalization. Automatic domains follow support instead of the origin. */
  centeredAtOrigin: boolean;
  /** Expands GPU bounds when live particles approach the configured volume. Defaults to true. */
  autoExpand: boolean;
  /** Maximum physical extent per axis; a number applies to every axis. Defaults to Infinity.
   * Adaptive growth rejects excess bricks rather than moving an opposite retained face. */
  maxBounds: number | THREE.Vector3;
  /** Minimum physical extent per axis. Defaults to zero. */
  minBounds: number | THREE.Vector3;
  /** Automatically request quality changes independently of physical domain growth. Defaults to true. */
  autoVolumeQuality: boolean;
  /** Static quality reference side; cell width is this value divided by the subdivision resolution. */
  volumeQuality: number;
  /** Minimum quality reference side. Defaults to two. */
  minVolumeQuality: number;
  /** Maximum quality reference side. Defaults to Infinity. */
  maxVolumeQuality: number;
  /** Shrinks an oversized power-of-two volume after a stable delay. Defaults to true. */
  autoShrink: boolean;
  /** Stable time expressed in 60 Hz frames before per-face shrinking. Defaults to 600. */
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
  /** GPU predicate checked between visits; stop once the caller's result is complete. */
  stopWhen?: () => Node<'bool'>;
  /** Skip hash buckets whose whole cell is outside the search sphere. Exact, not a neighbor budget. */
  pruneBounds?: boolean;
}

export type ParticleSpatialGridVisitor = (
  /** Shader-node view of a matching particle. */
  particle: GPUParticleLike,
  /** Squared simulation-space distance from the query center. */
  distanceSquared: Node<'float'>,
) => void;

export type ParticleSpatialGridParticleVisitor = (particle: GPUParticleLike) => void;

export interface ParticleSpatialGridRenderer extends GPUStorageBufferRenderer, GPUReadbackRenderer {
  compute(node: ComputeNode | ComputeNode[]): void;
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
  /** Per-axis absolute physical velocity, including the particle speed multiplier. */
  maxParticleVelocity: THREE.Vector3;
}

/**
 * Sparse GPU particle spatial hash. The logical brick/cell resolution is fixed;
 * storage scales with particle capacity rather than world volume.
 */
export default class ParticleSpatialGrid<L extends SpatialAggregateLayout = SpatialAggregateLayout>
  extends SpatialGrid {
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

  readonly automaticBounds: boolean;
  readonly minBounds = new THREE.Vector3();
  minVolumeQuality = 2;
  maxVolumeQuality = Infinity;
  private readonly dimensionsNode = uniform(new THREE.Vector3());
  private readonly shrinkSince = new Float64Array(6);
  autoVolumeQuality = true;
  volumeQuality = 2;
  private qualityRequestedAt = 0;
  private qualityRequest?: { occupied: THREE.Box3; guards?: SpatialGuardDepth; tier: number };
  private occupancyPending = false;
  private lastOccupancyRead = -Infinity;
  private pendingDomain?: THREE.Box3;

  get maxBounds(): THREE.Vector3 { return this._maxBounds; }
  set maxBounds(value: number | THREE.Vector3) {
    this.setOptions({ maxBounds: value });
  }

  get resourceVersion(): number { return this.version; }
  /** Maintained depths, normalized and including the mandatory finest neighbor index. */
  private levelsInput?: SpatialGridOptions['levels'];
  get levels(): readonly number[] {
    return Object.freeze(resolveSpatialLevels(this.levelsInput, this.brickSubdivisions, this.cellSubdivisions));
  }
  private regions?: GPUSpatialRegions<L>;
  private get maintainRegions(): boolean {
    return this.aggregator !== undefined || (this.levelsInput !== undefined
      && this.levelsInput !== SpatialLevels.None);
  }

  private capacity = 0;
  private hashCapacity = 0;
  private version = 0;
  private updateAccumulator = 0;
  private lastBufferVersion = -1;
  private lastBuildToken: unknown;
  private buildKey = '';

  private headAttribute?: StorageBufferAttribute;
  private linkAttribute?: StorageBufferAttribute;
  private coordinateAttribute?: StorageBufferAttribute;
  private boundsAttribute?: StorageBufferAttribute;
  private reductionAttribute?: StorageBufferAttribute;
  private diagnosticAttribute?: StorageBufferAttribute;

  private heads?: AtomicUintStorage;
  private coordinates?: PackedIntStorage;
  private gpuBounds?: PackedFloatStorage;
  private readonly _maxBounds = new THREE.Vector3(Infinity, Infinity, Infinity);
  private readonly maximumBoundsNode = uniform(new THREE.Vector3().setScalar(3.402823e38));
  private reductions?: AtomicUintStorage;
  private diagnostics?: AtomicUintStorage;

  /** Creates a sparse grid whose storage grows with particle capacity, not world volume. */
  constructor(options: Partial<ParticleSpatialGridOptions> = {},
    private readonly aggregator?: SpatialAggregator<L, SpatialBackend.GPU>) {
    super();
    this._brickSubdivisions = ParticleSpatialGrid.clampDepth(options.brickSubdivisions ?? 3);
    this._cellSubdivisions = ParticleSpatialGrid.clampDepth(options.cellSubdivisions ?? 4);
    this.levelsInput = options.levels;
    this.powerOfTwoBounds = options.powerOfTwoBounds ?? true;
    this.cubicBounds = options.cubicBounds ?? false;
    this.automaticBounds = options.bounds === undefined;
    this.centeredAtOrigin = this.automaticBounds ? false : (options.centeredAtOrigin ?? false);
    this.cubicBounds = this.automaticBounds ? false : this.cubicBounds;
    this.minBounds.copy(boundsVector(options.minBounds, 0));
    this.autoVolumeQuality = options.autoVolumeQuality ?? options.volumeQuality === undefined;
    this.volumeQuality = options.volumeQuality ?? options.minVolumeQuality ?? 2;
    this.minVolumeQuality = options.minVolumeQuality ?? 2;
    this.maxVolumeQuality = options.maxVolumeQuality ?? Infinity;
    this._maxBounds.copy(boundsVector(options.maxBounds, Infinity));
    this.updateMaximumBounds();
    const domain = this.resolveDomain(options.bounds ?? DEFAULT_BOUNDS, this.qualityOptions());
    this.bounds = domain.bounds.clone();
    this.adoptDomain(domain);
    this.dimensionsNode.value.copy(this.gridDimensions);
    this.autoExpand = this.automaticBounds && (options.autoExpand ?? true);
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
    const domain = this.resolveDomain(bounds ?? DEFAULT_BOUNDS, this.qualityOptions());
    this.bounds.copy(domain.bounds);
    this.adoptDomain(domain);
    this.dimensionsNode.value.copy(this.gridDimensions);
    this.lastBufferVersion = -1;
    if (this.boundsAttribute) this.writeInitialBounds();
    return this;
  }

  /** Seed an empty grid before populated simulation, without changing its subsequent adaptive policy. @internal */
  initializeVolumeQuality(referenceSide: number): void {
    if (!this.autoVolumeQuality) return;
    const quality = Math.max(this.minVolumeQuality, Math.min(this.maxVolumeQuality, referenceSide));
    const domain = createSpatialDomain(this.bounds, this.cellsPerAxis, 2 ** this.cellSubdivisions,
      { ...this.qualityOptions(), minVolumeQuality: quality, maxVolumeQuality: quality });
    this.resolvedDomains.set(domain.bounds, domain);
    this.setBounds(domain.bounds);
    this.qualityRequest = undefined;
    this.qualityRequestedAt = 0;
  }

  /** Applies grid options and rebuilds structural GPU work on the next update. */
  setOptions(options: Partial<Omit<ParticleSpatialGridOptions, 'bounds'>>): this {
    if (options.maxBounds !== undefined) {
      this._maxBounds.copy(boundsVector(options.maxBounds, Infinity));
    }
    if (options.autoVolumeQuality !== undefined) {
      this.autoVolumeQuality = options.autoVolumeQuality;
      if (!options.autoVolumeQuality && options.volumeQuality === undefined) {
        this.volumeQuality = this.volumeQualityTier;
      }
    }
    if (options.volumeQuality !== undefined) {
      if (!(options.volumeQuality > 0) || !Number.isFinite(options.volumeQuality)) {
        throw new RangeError('volumeQuality must be positive and finite.');
      }
      this.volumeQuality = options.volumeQuality;
      if (options.autoVolumeQuality === undefined) this.autoVolumeQuality = false;
    }
    this.qualityRequest = undefined;
    if (options.minBounds !== undefined) this.minBounds.copy(boundsVector(options.minBounds, 0));
    if (options.minVolumeQuality !== undefined) this.minVolumeQuality = options.minVolumeQuality;
    if (options.maxVolumeQuality !== undefined) this.maxVolumeQuality = options.maxVolumeQuality;
    if (options.levels !== undefined) this.levelsInput = options.levels;
    if (options.brickSubdivisions !== undefined) {
      this.brickSubdivisions = options.brickSubdivisions;
    }
    if (options.cellSubdivisions !== undefined) {
      this.cellSubdivisions = options.cellSubdivisions;
    }
    if (options.powerOfTwoBounds !== undefined) this.powerOfTwoBounds = options.powerOfTwoBounds;
    if (options.cubicBounds !== undefined) this.cubicBounds = this.automaticBounds ? false : options.cubicBounds;
    if (options.centeredAtOrigin !== undefined) {
      this.centeredAtOrigin = this.automaticBounds ? false : options.centeredAtOrigin;
    }
    if (options.autoExpand !== undefined) this.autoExpand = this.automaticBounds && options.autoExpand;
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
    this.updateMaximumBounds();
    this.resolvedDomains = new WeakMap();
    // Editing an unrelated setting must not turn the allocated rectangle into a quality request.
    const qualityOptions = this.automaticBounds && this.autoVolumeQuality && options.powerOfTwoBounds === undefined
      && options.minVolumeQuality === undefined
      && options.maxVolumeQuality === undefined ? {
        ...this, maxBounds: this.maxBounds,
        minVolumeQuality: this.volumeQualityTier, maxVolumeQuality: this.volumeQualityTier,
      } : this.qualityOptions();
    const domain = createSpatialDomain(this.domainTarget, this.cellsPerAxis, 2 ** this.cellSubdivisions,
      qualityOptions, this.volumeQualityTier || undefined);
    this.bounds.copy(domain.bounds); this.adoptDomain(domain);
    this.dimensionsNode.value.copy(this.gridDimensions);
    this.lastBufferVersion = -1;
    this.version += 1;
    if (this.boundsAttribute) this.writeInitialBounds();
    return this;
  }

  protected invalidateStructure(): void {
    if (this.bounds && this.dimensionsNode) {
      this.resolvedDomains = new WeakMap();
      const domain = createSpatialDomain(this.domainTarget, this.cellsPerAxis, 2 ** this.cellSubdivisions,
        this.qualityOptions(), this.volumeQualityTier || undefined);
      this.bounds.copy(domain.bounds);
      this.adoptDomain(domain);
      this.dimensionsNode.value.copy(this.gridDimensions);
      if (this.boundsAttribute) this.writeInitialBounds();
    }
    this.lastBufferVersion = -1;
    this.lastBuildToken = undefined;
    this.version += 1;
    this.buildBufferVersion = -1;
  }

  /** Returns the logical cell coordinate using the currently configured CPU-side bounds. */
  locate(position: THREE.Vector3, depth = this.maxDepth): THREE.Vector3 {
    if (!Number.isInteger(depth) || depth < 0 || depth > this.maxDepth) throw new RangeError('Invalid spatial depth.');
    return ParticleSpatialGrid.locate(position, this.bounds,
      this.gridDimensions.clone().divideScalar(2 ** (this.maxDepth - depth)).ceil());
  }

  /** GPU bounds from the current index; CPU `bounds` does not include automatic GPU expansion. */
  getBoundsNode(): { min: Node<'vec3'>; max: Node<'vec3'> } {
    if (!this.gpuBounds) throw new Error('Initialize the spatial grid before creating GPU bounds expressions.');
    return { min: this.gpuBounds.element(0).xyz, max: this.gpuBounds.element(1).xyz };
  }

  getBounds(region: GPUSpatialRegion): { min: Node<'vec3'>; max: Node<'vec3'> } {
    const bounds = this.getBoundsNode();
    const size = this.getCellSizeNode().mul(2 ** (this.maxDepth - region.depth));
    const min = bounds.min.add(vec3(this.regionDirectory.getCoordinate(region)).mul(size));
    return { min, max: min.add(size) };
  }

  locateNode(position: Node<'vec3'>, depth = this.maxDepth): GPUSpatialRegion {
    return this.regionDirectory.locate(position, depth);
  }

  getAggregate(region: GPUSpatialRegion) {
    return this.regionDirectory.getAggregate(region);
  }

  getChildren(region: GPUSpatialRegion) {
    return this.regionDirectory.getChildren(region);
  }

  getRegions(depth: number) {
    return this.regionDirectory.getRegions(depth);
  }

  getParticleIndices(region: GPUSpatialRegion) {
    return this.regionDirectory.getParticleIndices(region);
  }

  computeRegions(depth: number, callback: (region: GPUSpatialRegion) => void): ComputeNode {
    return this.regionDirectory.computeRegions(depth, callback);
  }

  private get regionDirectory(): GPUSpatialRegions<L> {
    if (!this.regions) throw new Error('Request levels or an aggregator and initialize the spatial grid first.');
    return this.regions;
  }

  /** Allocates reusable grid storage before shader query graphs are constructed. */
  initialize(renderer: ParticleSpatialGridRenderer, buffers: GPUParticleBufferState): void {
    this.ensureCapacity(renderer, buffers.capacity);
    if (this.currentBuffers !== buffers) {
      this.buildNodes?.forEach(node => node.dispose());
      this.buildNodes = undefined;
      this.buildBufferVersion = -1;
    }
    this.currentBuffers = buffers;
  }

  /** Alias matching the CPU utility's rebuild terminology. */
  rebuild(
    renderer: ParticleSpatialGridRenderer,
    buffers: GPUParticleBufferState,
    buildToken?: unknown,
    range?: GPUComputeRange,
  ): boolean {
    if (this.pendingDomain) {
      this.setBounds(this.pendingDomain);
      this.pendingDomain = undefined;
    }
    if (buildToken !== undefined && this.lastBuildToken === buildToken && this.lastBufferVersion === buffers.version) {
      return false;
    }
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

    const nodes = this.getBuildNodes(buffers, range);
    if (!range) {
      for (const node of nodes) {
        if (node.name === 'rzmps.grid.reduce' || node.name === 'rzmps.grid.insert') node.count = buffers.count;
      }
    }
    renderer.compute(nodes);
    this.regions?.rebuild(renderer, buffers, range);
    if (this.automaticBounds && this.autoExpand) this.pollDomain(renderer);
    return true;
  }

  getDimensionsNode(): Node<'vec3'> { return this.dimensionsNode; }

  /** Restore empty guard bricks from actual support; removal waits independently on each face. */
  resolveOccupiedBounds(occupied: THREE.Box3, now = performance.now(), guards?: SpatialGuardDepth): THREE.Box3 {
    if (!this.automaticBounds || occupied.isEmpty()) return this.bounds;
    const desired = this.resolveGuardDomain(occupied, this.qualityOptions(), guards);
    if (desired.qualitySide !== this.volumeQualityTier) {
      // Continued growth may cross several tiers during preparation. Debounce the direction,
      // not the exact destination, or an evolving plume can postpone coarsening indefinitely.
      const direction = Math.sign(desired.qualitySide - this.volumeQualityTier);
      if (!this.qualityRequest || Math.sign(this.qualityRequest.tier - this.volumeQualityTier) !== direction) {
        this.qualityRequestedAt = now;
      }
      this.qualityRequest = { occupied: occupied.clone(), guards, tier: desired.qualitySide };
    } else this.qualityRequest = undefined;

    // Restore coverage now, using the current lattice. Quality is a separate, deferred request.
    const domain = this.resolveGuardDomain(occupied, {
      ...this, maxBounds: Infinity,
      minVolumeQuality: this.volumeQualityTier, maxVolumeQuality: this.volumeQualityTier,
    }, guards);
    const delay = this.shrinkDelay * 1000 / 60;

    // Movement emerges from independent growth and delayed removal; no center-following translation.
    if (Math.abs(domain.cellSize - this.cellSize) < 1e-9) {
      for (const axis of ['x', 'y', 'z'] as const) {
        for (const upper of [false, true]) {
          const face = ['x', 'y', 'z'].indexOf(axis) * 2 + Number(upper);
          const end = upper ? 'max' : 'min', direction = upper ? 1 : -1;
          const difference = (domain.bounds[end][axis] - this.bounds[end][axis]) * direction;
          if (difference > 1e-6) {
            this.shrinkSince[face] = 0;
            this.domainDiagnostics.growth[face]++;
          } else if (difference < -1e-6) {
            this.shrinkSince[face] ||= now;
            if (!this.autoShrink || now - this.shrinkSince[face] < delay) {
              domain.bounds[end][axis] = this.bounds[end][axis];
            } else {
              this.shrinkSince[face] = 0;
              this.domainDiagnostics.shrink[face]++;
            }
          } else this.shrinkSince[face] = 0;
        }
        // A maximum is an admission limit, not permission for a new face to evict the old one.
        // Keep independently accepted shrinkage, then admit whole bricks into the remaining space.
        const maximum = Math.floor(this.maxBounds[axis] / domain.brickSize + 1e-6) * domain.brickSize;
        const lower = Math.max(domain.bounds.min[axis], this.bounds.min[axis]);
        const upper = Math.min(domain.bounds.max[axis], this.bounds.max[axis]);
        if (lower > upper) {
          domain.bounds.min[axis] = this.bounds.min[axis];
          domain.bounds.max[axis] = this.bounds.max[axis];
          continue;
        }
        let available = Math.max(0, maximum - (upper - lower));
        const lowerGrowth = Math.min(lower - domain.bounds.min[axis], available);
        domain.bounds.min[axis] = lower - lowerGrowth;
        available -= lowerGrowth;
        domain.bounds.max[axis] = upper + Math.min(domain.bounds.max[axis] - upper, available);
        domain.hardCapBreach ||= available < domain.brickSize
          && (domain.bounds.min[axis] > occupied.min[axis] || domain.bounds.max[axis] < occupied.max[axis]);
      }
    }
    domain.brickDimensions.copy(domain.bounds.getSize(new THREE.Vector3())).divideScalar(domain.brickSize).round();
    domain.gridDimensions.copy(domain.brickDimensions).multiplyScalar(2 ** this.cellSubdivisions);
    this.recordDomainRequest(domain);
    this.resolvedDomains.set(domain.bounds, domain);
    return domain.bounds;
  }

  /** Consume a stable quality request separately, after urgent domain coverage has been applied. */
  resolveDeferredQuality(now = performance.now(),
    ready?: (domain: SpatialGridDomain) => boolean): THREE.Box3 | undefined {
    const request = this.qualityRequest;
    if (!request) return undefined;
    // Quality changes debounce in both directions independently of geometric shrink policy.
    const domain = this.resolveGuardDomain(request.occupied, this.qualityOptions(), request.guards);
    // A quality switch changes the lattice, not which retained faces may be evicted.
    // Delayed face removal remains the responsibility of ordinary coverage updates.
    for (const axis of ['x', 'y', 'z'] as const) {
      const brick = domain.brickSize;
      const maximum = Math.floor(this.maxBounds[axis] / brick + 1e-6) * brick;
      let low = Math.floor(this.bounds.min[axis] / brick + 1e-6) * brick;
      let high = Math.ceil(this.bounds.max[axis] / brick - 1e-6) * brick;
      if (high - low > maximum) {
        // Coarsening may round both faces out by one brick; keep the closest aligned cap.
        low = Math.round(this.bounds.min[axis] / brick) * brick;
        high = low + maximum;
      }
      let available = Math.max(0, maximum - (high - low));
      const lowerGrowth = Math.min(Math.max(0, low - domain.bounds.min[axis]), available);
      low -= lowerGrowth;
      available -= lowerGrowth;
      high += Math.min(Math.max(0, domain.bounds.max[axis] - high), available);
      domain.bounds.min[axis] = low; domain.bounds.max[axis] = high;
      domain.brickDimensions[axis] = Math.round((high - low) / brick);
      domain.gridDimensions[axis] = domain.brickDimensions[axis] * 2 ** this.cellSubdivisions;
    }
    // Prepare during hysteresis, not after it. The live tier still waits for both conditions.
    const prepared = !ready || ready(domain);
    if (now - this.qualityRequestedAt < 1000 || !prepared) return undefined;
    this.qualityRequest = undefined;
    this.resolvedDomains.set(domain.bounds, domain);
    return domain.bounds;
  }

  private qualityOptions() {
    return this.autoVolumeQuality ? this : {
      ...this, maxBounds: this.maxBounds, minVolumeQuality: this.volumeQuality, maxVolumeQuality: this.volumeQuality,
    };
  }

  private pollDomain(renderer: ParticleSpatialGridRenderer): void {
    if (this.occupancyPending || performance.now() - this.lastOccupancyRead < 16) return;
    this.occupancyPending = true;
    this.lastOccupancyRead = performance.now();
    const generation = this.version;
    void this.readParticleBounds(renderer).then(occupied => {
      if (generation === this.version && !occupied.isEmpty()) {
        const coverage = this.resolveOccupiedBounds(occupied);
        this.pendingDomain = coverage.equals(this.bounds) ? this.resolveDeferredQuality() ?? coverage : coverage;
      }
    }).catch(() => {}).finally(() => {
      if (generation === this.version) this.occupancyPending = false;
    });
  }

  /** Builds particle work over the current CPU range or a caller-scheduled GPU compact range.
   * The caller owns indirect arguments and must write them before dispatching the returned kernel.
   * Callers of CPU-sized kernels can update ComputeNode.count without rebuilding the graph.
   */
  computeParticles(callback: (particle: GPUParticleLike) => void, range?: GPUComputeRange): ComputeNode {
    this.assertReady();
    const visit = () => callback(this.currentBuffers!.storage.createParticle(undefined, true));
    return range ? computeRange(range, visit) : Fn(visit)().compute(this.currentBuffers!.count);
  }

  /**
   * Emits a shader-side exact-radius query. The callback receives a loaded particle
   * and may read all particle attributes. No JavaScript particle array is created.
   */
  /** GPU-resolved cell extent, including automatic bounds expansion. */
  getCellSizeNode(): Node<'vec3'> {
    this.assertReady();
    return this.gpuBounds!.element(1).xyz
      .sub(this.gpuBounds!.element(0).xyz)
      .div(this.dimensionsNode) as Node<'vec3'>;
  }

  /**
   * Bounded nearest-neighbor spacing for visual density compensation. Searches
   * the containing cell first, so distant clusters cannot consume the query
   * budget before the caller's own cluster. Sparse fallback uses visual size,
   * never the size of the grid's accumulated world bounds.
   */
  estimateLocalSpacingNode(
    position: Node<'vec3'>,
    excludeIndex: Node<'uint'>,
    fallbackRadius: Node<'float'>,
  ): Node<'float'> {
    this.assertReady();
    const coordinate = this.coordinateNode(position).toVar();
    const reachSquared = fallbackRadius.max(0.001).mul(8).pow(2);
    const nearest = reachSquared.add(1).toVar();
    const found = uint(0).toVar();
    const visit = (cell: Node<'ivec3'>, budget: number) => {
      const encoded = atomicLoad(this.heads!.element(this.hashCoordinateNode(cell))).toVar();
      const visited = uint(0).toVar();
      Loop(() => {
        If(encoded.equal(uint(0)).or(visited.greaterThanEqual(uint(budget))), () => {
          Break();
        });
        const slot = encoded.sub(1).toVar();
        If(slot.greaterThanEqual(uint(this.capacity)), () => {
          Break();
        });
        const record = this.coordinates!.element(slot);
        const particle = this.currentBuffers!.storage.createParticle(slot);
        const exact = record.x.equal(cell.x).and(record.y.equal(cell.y)).and(record.z.equal(cell.z));
        const accepted = exact.and(slot.notEqual(excludeIndex))
          .and(particle.alive.notEqual(uint(0)))
          .and(particle.generation.equal(uint(record.w)));
        If(accepted, () => {
          const distanceSquared = particle.position.sub(position).lengthSq();
          If(distanceSquared.lessThanEqual(reachSquared), () => {
            nearest.assign(nearest.min(distanceSquared));
            found.assign(uint(1));
          });
        });
        encoded.assign(atomicLoad(this.heads!.element(slot.add(this.hashCapacity))));
        visited.addAssign(1);
      });
    };
    visit(coordinate, 64);
    If(found.equal(uint(0)), () => {
      for (const [x, y, z] of [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]]) {
        const neighbor = coordinate.add(ivec3(x, y, z));
        const inside = neighbor.x.greaterThanEqual(int(0))
          .and(neighbor.y.greaterThanEqual(int(0)))
          .and(neighbor.z.greaterThanEqual(int(0)))
          .and(neighbor.x.lessThan(int(this.dimensionsNode.x)))
          .and(neighbor.y.lessThan(int(this.dimensionsNode.y)))
          .and(neighbor.z.lessThan(int(this.dimensionsNode.z)));
        If(this.automaticBounds ? uint(1).equal(1) : inside, () => visit(neighbor, 16));
      }
    });
    return found.notEqual(uint(0)).select(nearest.max(0).sqrt().mul(0.5), fallbackRadius) as Node<'float'>;
  }

  forEachParticleInRadius(
    position: Node<'vec3'>,
    radius: Node<'float'>,
    callback: ParticleSpatialGridVisitor,
    options: ParticleSpatialGridQueryOptions = {},
  ): void {
    this.assertReady();
    const queryMin = this.coordinateNode(position.sub(radius)).toVar();
    const queryMax = this.coordinateNode(position.add(radius)).toVar();
    const radiusSquared = float(radius.mul(radius)).toVar();
    const cellSize = options.pruneBounds ? this.getCellSizeNode().toVar() : undefined;
    const cellPoint = cellSize ? position.sub(this.getBoundsNode().min).div(cellSize).toVar() : undefined;
    const compactQuery = cellSize ? radius.lessThanEqual(
      min(cellSize.x, min(cellSize.y, cellSize.z)).mul(1.5),
    ).toVar() : undefined;
    const visited = uint(0).toVar('spatialGridVisited');

    const traverse = (prune: boolean) => {
      Loop(
        { start: queryMin.x, end: queryMax.x.add(1) },
        { start: queryMin.y, end: queryMax.y.add(1) },
        ({ i: gridX, j: gridY }) => {
          if (options.stopWhen) If(options.stopWhen(), () => Break());
          const gridZ = int(queryMin.z).toVar('spatialGridZ');
          Loop(() => {
            if (options.stopWhen) If(options.stopWhen(), () => Break());
            If(gridZ.greaterThan(queryMax.z), () => {
              Break();
            });
            if (this.maxQuerySteps > 0) {
              If(visited.greaterThanEqual(uint(this.maxQuerySteps)), () => {
                Break();
              });
            }
            const coordinate = ivec3(int(gridX), int(gridY), int(gridZ));
            const visitBucket = () => {
              const bucket = this.hashCoordinateNode(coordinate);
              const encoded = atomicLoad(this.heads!.element(bucket)).toVar('spatialGridLink');
              const chainSteps = uint(0).toVar('spatialGridChainSteps');

              Loop(() => {
                if (options.stopWhen) If(options.stopWhen(), () => Break());
                If(encoded.equal(uint(EMPTY_LINK)), () => {
                  Break();
                });
                // A valid bucket visits each slot at most once. This integrity bound is exact,
                // independent of the optional query-quality budget, and prevents cyclic GPU hangs.
                If(chainSteps.greaterThanEqual(uint(this.capacity)), () => {
                  Break();
                });
                chainSteps.addAssign(1);
                const slot = encoded.sub(1).toVar('spatialGridSlot');
                If(slot.greaterThanEqual(uint(this.capacity)), () => {
                  Break();
                });

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
                encoded.assign(atomicLoad(this.heads!.element(slot.add(this.hashCapacity))));
              });
            };
            if (prune && cellSize && cellPoint) {
              const distance = vec3(coordinate).sub(cellPoint).max(0)
                .add(cellPoint.sub(vec3(coordinate).add(1)).max(0)).mul(cellSize).toVar();
              If(distance.lengthSq().lessThanEqual(radiusSquared.mul(1.000001)), visitBucket);
            } else visitBucket();
            gridZ.addAssign(1);
          });
        },
      );
    };
    // Choose once per query, not once per bucket. Wide queries retain the original inexpensive loop.
    if (compactQuery) If(compactQuery, () => traverse(true)).Else(() => traverse(false));
    else traverse(false);
  }

  /** Emits a GPU bounds update for a grid whose caller already reduced the population.
   * Set autoExpand to false when supplying fresh bounds this way each frame.
   */
  setBoundsNode(minimum: Node<'vec3'>, maximum: Node<'vec3'>): void {
    this.assertReady();
    const size = maximum.sub(minimum).max(vec3(1e-6));
    const lower = minimum.sub(size.mul(0.001));
    const upper = minimum.add(size.mul(1.001));
    const center = lower.add(upper).mul(0.5).toVar();
    const half = upper.sub(lower).min(this.maximumBoundsNode).mul(0.5).toVar();
    this.gpuBounds!.element(0).assign(vec4(center.sub(half), 0));
    this.gpuBounds!.element(1).assign(vec4(center.add(half), 0));
  }

  /** Exact nearest neighbor, pruning hash cells against the current best distance.
   * Returns 0xffffffff when no particle lies within radius; negative radius is unbounded.
   * Use a coarse grid for small representative populations. No per-query traversal cap applies.
   */
  nearestParticleIndexNode(position: Node<'vec3'>, radius: Node<'float'>): Node<'uint'> {
    this.assertReady();
    const minimum = this.gpuBounds!.element(0).xyz;
    const cellSize = this.getCellSizeNode();
    const coordinate = this.coordinateNode(position).toVar();
    const best = radius.lessThan(0).select(float(3.402823e38), radius.mul(radius)).toVar();

    const result = uint(0xffffffff).toVar();
    const visit = (cell: Node<'ivec3'>) => {
      const lower = minimum.add(vec3(cell).mul(cellSize));
      const delta = lower.sub(position).max(position.sub(lower.add(cellSize))).max(vec3(0));

      If(delta.lengthSq().lessThanEqual(best), () => {
        const encoded = atomicLoad(this.heads!.element(this.hashCoordinateNode(cell))).toVar();
        const chainSteps = uint(0).toVar();

        Loop(() => {
          If(encoded.equal(uint(0)), () => { Break(); });
          If(chainSteps.greaterThanEqual(uint(this.capacity)), () => {
            Break();
          });
          chainSteps.addAssign(1);

          const slot = encoded.sub(1).toVar();
          If(slot.greaterThanEqual(uint(this.capacity)), () => { Break(); });
          const record = this.coordinates!.element(slot);
          const p = this.currentBuffers!.storage.createParticle(slot);
          const exact = record.x.equal(cell.x).and(record.y.equal(cell.y)).and(record.z.equal(cell.z));

          If(exact.and(p.alive.notEqual(uint(0))).and(p.generation.equal(uint(record.w))), () => {

            const distance = p.position.sub(position).lengthSq();

            If(distance.lessThan(best).or(distance.equal(best).and(slot.lessThan(result))), () => {
              best.assign(distance); result.assign(slot);
            });
          });

          encoded.assign(atomicLoad(this.heads!.element(slot.add(this.hashCapacity))));
        });
      });
    };

    visit(coordinate);

    Loop(int(this.dimensionsNode.x.mul(this.dimensionsNode.y).mul(this.dimensionsNode.z)), ({ i }) => {
      const cell = ivec3(int(i).mod(int(this.dimensionsNode.x)),
        int(i).div(int(this.dimensionsNode.x)).mod(int(this.dimensionsNode.y)),
        int(i).div(int(this.dimensionsNode.x.mul(this.dimensionsNode.y))));

      If(cell.x.notEqual(coordinate.x).or(cell.y.notEqual(coordinate.y)).or(cell.z.notEqual(coordinate.z)), () => {
        visit(cell);
      });
    });
    if (this.automaticBounds) If(atomicLoad(this.diagnostics!.element(1)).notEqual(0), () => {
      Loop(this.capacity, ({ i }) => {
      const record = this.coordinates!.element(i);
      const outside = vec3(record.xyz).lessThan(vec3(0)).any()
        .or(vec3(record.xyz).greaterThanEqual(this.dimensionsNode).any());
      const particle = this.currentBuffers!.storage.createParticle(uint(i));
      If(outside.and(particle.alive.notEqual(uint(0)))
        .and(particle.generation.equal(uint(record.w))), () => {
        const distance = particle.position.sub(position).lengthSq();
        If(distance.lessThan(best).or(distance.equal(best).and(uint(i).lessThan(result))), () => {
          best.assign(distance); result.assign(uint(i));
        });
      });
      });
    });
    return result;
  }

  /** Releases GPU attributes owned by this grid. Explicitly shared grids remain caller-owned. */
  dispose(renderer?: GPUStorageBufferRenderer): void {
    this.version++;
    this.occupancyPending = false;
    this.pendingDomain = undefined;
    this.regions?.dispose(renderer);
    this.regions = undefined;
    this.buildNodes?.forEach(node => node.dispose());
    this.buildNodes = undefined;
    this.buildBufferVersion = -1;
    this.buildRange = undefined;
    this.lastBuildToken = undefined;
    this.lastBufferVersion = -1;
    [
      this.headAttribute,
      this.coordinateAttribute,
      this.boundsAttribute,
      this.reductionAttribute,
      this.diagnosticAttribute,
    ].forEach((attribute) => {
      if (attribute) destroyGPUStorageAttribute(renderer, attribute);
    });
    this.buildNodes = undefined;
    this.buildKey = '';
    this.capacity = 0;
    this.hashCapacity = 0;
    this.headAttribute = undefined;
    this.linkAttribute = undefined;
    this.coordinateAttribute = undefined;
    this.boundsAttribute = undefined;
    this.reductionAttribute = undefined;
    this.diagnosticAttribute = undefined;
    this.heads = undefined;
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
    const heads = new Uint32Array(headBuffer).subarray(0, this.hashCapacity);
    const links = new Uint32Array(linkBuffer).subarray(this.hashCapacity);
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
    if (!this.reductionAttribute) {
      throw new Error('ParticleSpatialGrid must be rebuilt before reading particle bounds.');
    }
    const values = new Uint32Array(await renderer.getArrayBufferAsync(this.reductionAttribute));
    if (values[BoundsReduction.HasParticles] === 0) {
      return { bounds: new THREE.Box3(), maxParticleSpeed: 0, maxParticleVelocity: new THREE.Vector3() };
    }
    return {
      bounds: new THREE.Box3(
        new THREE.Vector3(
          unorderedFloatBits(values[BoundsReduction.MinimumX]),
          unorderedFloatBits(values[BoundsReduction.MinimumY]),
          unorderedFloatBits(values[BoundsReduction.MinimumZ]),
        ),
        new THREE.Vector3(
          unorderedFloatBits(values[BoundsReduction.MaximumX]),
          unorderedFloatBits(values[BoundsReduction.MaximumY]),
          unorderedFloatBits(values[BoundsReduction.MaximumZ]),
        ),
      ),
      maxParticleSpeed: Math.max(
        0,
        unorderedFloatBits(values[BoundsReduction.MaximumParticleSpeed]),
      ),
      maxParticleVelocity: new THREE.Vector3(
        unorderedFloatBits(values[BoundsReduction.MaximumVelocityX]),
        unorderedFloatBits(values[BoundsReduction.MaximumVelocityY]),
        unorderedFloatBits(values[BoundsReduction.MaximumVelocityZ]),
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

  static hashCoordinate(coordinate: THREE.Vector3, hashCapacity: number): number {
    const x = coordinate.x | 0;
    const y = coordinate.y | 0;
    const z = coordinate.z | 0;
    return (((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0)
      & (hashCapacity - 1);
  }

  private currentBuffers?: GPUParticleBufferState;
  private buildNodes?: ComputeNode[];
  private buildBufferVersion = -1;
  private buildRange?: GPUComputeRange;

  private regionStructure = '';

  private ensureCapacity(renderer: GPUStorageBufferRenderer, capacity: number): void {
    const structure = `${this.maintainRegions}:${this.levels.join(',')}`
      + (this.maintainRegions ? `:${this.gridDimensions.toArray()}` : '');
    if (capacity === this.capacity && this.headAttribute && this.regionStructure === structure) return;
    this.dispose(renderer);
    this.regionStructure = structure;
    this.capacity = Math.max(1, capacity);
    this.hashCapacity = nextPowerOfTwo(this.capacity * 2);
    this.version += 1;

    this.headAttribute = new StorageBufferAttribute(new Uint32Array(this.hashCapacity + this.capacity), 1);
    this.linkAttribute = this.headAttribute;
    this.coordinateAttribute = new StorageBufferAttribute(new Int32Array(this.capacity * 4), 4);
    this.boundsAttribute = new StorageBufferAttribute(new Float32Array(8), 4);
    this.reductionAttribute = new StorageBufferAttribute(new Uint32Array(REDUCTION_WORDS), 1);
    this.diagnosticAttribute = new StorageBufferAttribute(new Uint32Array(2), 1);
    this.writeInitialBounds();

    this.heads = storage(this.headAttribute, 'uint', this.hashCapacity + this.capacity).toAtomic() as AtomicUintStorage;
    this.coordinates = storage(this.coordinateAttribute, 'ivec4', this.capacity) as PackedIntStorage;
    this.gpuBounds = storage(this.boundsAttribute, 'vec4', 2) as PackedFloatStorage;
    this.reductions = storage(this.reductionAttribute, 'uint', REDUCTION_WORDS).toAtomic() as AtomicUintStorage;
    this.diagnostics = storage(this.diagnosticAttribute, 'uint', 2).toAtomic() as AtomicUintStorage;
    if (this.maintainRegions) {
      this.regions = new GPUSpatialRegions(this, this.capacity, this.levels, this.aggregator, renderer);
    }
  }

  private getBuildNodes(buffers: GPUParticleBufferState, range?: GPUComputeRange): ComputeNode[] {
    // Bounds/quality generations only change uniforms. Storage replacement and structural edits
    // already clear buildNodes/buildBufferVersion; do not rebuild five programs for a runtime tier edit.
    const key = [this.automaticBounds, this.autoExpand, this.autoShrink, this.powerOfTwoBounds,
      this.cubicBounds, this.centeredAtOrigin, this.expansionHysteresis, this.shrinkDelay].join('|');
    if (this.buildKey === key && this.currentBuffers === buffers
      && this.buildBufferVersion === buffers.version && this.buildNodes
      && this.buildRange?.count === range?.count
      && this.buildRange?.dispatch === range?.dispatch) return this.buildNodes;
    this.buildNodes?.forEach(node => node.dispose());
    this.currentBuffers = buffers;
    this.buildBufferVersion = buffers.version;
    this.buildRange = range;
    this.buildKey = key;
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
        If(instanceIndex.greaterThanEqual(uint(BoundsReduction.MaximumParticleSpeed)), () => {
          atomicStore(this.reductions!.element(instanceIndex), uint(0));
        });
      });

      If(instanceIndex.equal(uint(0)), () => {
        atomicStore(this.diagnostics!.element(0), uint(0));
        atomicStore(this.diagnostics!.element(1), uint(0));
      });
    })().compute(Math.max(this.hashCapacity, REDUCTION_WORDS)).setName('rzmps.grid.reset');

    const reduce = this.computeParticles(particle => {
      If(particle.alive.notEqual(uint(0)), () => {
        const radius = max(
          particle.scale.x.abs(),
          max(particle.scale.y.abs(), particle.scale.z.abs()),
        ).mul(0.5);

        (['x', 'y', 'z'] as const).forEach((axis, i) => {
          atomicMin(this.reductions!.element(i), orderedFloatNode(particle.position[axis].sub(radius)));
          atomicMax(this.reductions!.element(i + 3), orderedFloatNode(particle.position[axis].add(radius)));
        });
        atomicStore(this.reductions!.element(BoundsReduction.HasParticles), uint(1));
        atomicMax(
          this.reductions!.element(BoundsReduction.MaximumParticleRadius),
          orderedFloatNode(radius),
        );
        // Render snapshots carry velocity without a separate speed channel; simulation views have both.
        const velocity = particle.velocity.mul(particle.speed ?? 1).abs();
        atomicMax(
          this.reductions!.element(BoundsReduction.MaximumParticleSpeed),
          orderedFloatNode(velocity.length()),
        );
        (['x', 'y', 'z'] as const).forEach((axis, index) => {
          atomicMax(this.reductions!.element(BoundsReduction.MaximumVelocityX + index),
            orderedFloatNode(velocity[axis]));
        });
      });
    }, range).setName('rzmps.grid.reduce');

    const finalize = Fn(() => {})().compute(1).setName('rzmps.grid.bounds');

    const finalizeRadius = Fn(() => {
      const boundsMin = this.gpuBounds!.element(0);
      const boundsMax = this.gpuBounds!.element(1);
      const center = boundsMin.xyz.add(boundsMax.xyz).mul(0.5).toVar();
      const half = boundsMax.xyz.sub(boundsMin.xyz).min(this.maximumBoundsNode).mul(0.5).toVar();
      this.gpuBounds!.element(0).assign(vec4(
        center.sub(half),
        unorderedFloatNode(atomicLoad(
          this.reductions!.element(BoundsReduction.MaximumParticleRadius),
        )),
      ));
      this.gpuBounds!.element(1).assign(vec4(center.add(half), boundsMax.w));
    })().compute(1);

    const insert = this.computeParticles(particle => {
      If(particle.alive.notEqual(uint(0)), () => {
        const boundsMin = vec3(this.gpuBounds!.element(0).xyz);
        const boundsMax = vec3(this.gpuBounds!.element(1).xyz);
        const inside = particle.position.greaterThanEqual(boundsMin).all()
          .and(particle.position.lessThanEqual(boundsMax).all());

        if (this.automaticBounds) If(inside.not(), () => {
          atomicStore(this.diagnostics!.element(1), uint(1));
        });
        If(this.automaticBounds ? uint(1).equal(1) : inside, () => {
          const coordinate = this.coordinateNode(particle.position);

          const bucket = this.hashCoordinateNode(coordinate);
          const encoded = particle.index.add(uint(1));
          const previous = atomicFunc(
            'atomicExchange' as Parameters<typeof atomicFunc>[0],
            this.heads!.element(bucket),
            encoded,
          );

          atomicStore(this.heads!.element(particle.index.add(this.hashCapacity)), previous);

          this.coordinates!.element(particle.index).assign(
            ivec4(coordinate.x, coordinate.y, coordinate.z, int(particle.generation)),
          );
        });
      });
    }, range).setName('rzmps.grid.insert');

    this.buildNodes = [reset, reduce, finalize, finalizeRadius, insert];
    return this.buildNodes;
  }

  private coordinateNode(position: Node<'vec3'>): Node<'ivec3'> {
    const coordinate = floor(position.sub(this.gpuBounds!.element(0).xyz).div(this.getCellSizeNode()));
    return ivec3(this.automaticBounds ? coordinate : clamp(coordinate, vec3(0), this.dimensionsNode.sub(1)));
  }

  private hashCoordinateNode(coordinate: Node<'ivec3'>): Node<'uint'> {
    return uint(coordinate.x).mul(73856093)
      .bitXor(uint(coordinate.y).mul(19349663))
      .bitXor(uint(coordinate.z).mul(83492791))
      .bitAnd(uint(this.hashCapacity - 1));
  }

  /** Resolve the final normalized, capped domain for externally supplied support bounds. */
  resolveBounds(bounds: THREE.Box3): THREE.Box3 {
    // Never reinterpret already allocated/snapped geometry as a fresh quality target.
    const prepared = this.resolvedDomains.get(bounds);
    if (bounds.equals(this.bounds) && (!prepared || prepared.cellSize === this.cellSize)) return this.bounds;
    return this.resolveDomain(bounds, {
      ...this, maxBounds: this.maxBounds,
      minVolumeQuality: this.volumeQualityTier, maxVolumeQuality: this.volumeQualityTier,
    }).bounds;
  }

  private writeInitialBounds(): void {
    if (!this.boundsAttribute) return;
    const array = this.boundsAttribute.array as Float32Array;
    array.set([...this.bounds.min.toArray(), 0, ...this.bounds.max.toArray(), 0]);
    this.boundsAttribute.needsUpdate = true;
  }

  private updateMaximumBounds(): void {
    if (this._maxBounds.toArray().some(value => !(value > 0))) throw new RangeError('maxBounds must be positive.');
    this.maximumBoundsNode.value.copy(this._maxBounds).min(new THREE.Vector3().setScalar(3.402823e38));
  }

  private assertReady(): void {
    if (!this.currentBuffers || !this.heads || !this.coordinates || !this.gpuBounds) {
      throw new Error('ParticleSpatialGrid must be rebuilt before creating query nodes.');
    }
  }

  // Bound subdivision depth before allocating coordinate storage.
  private static clampDepth(value: number): number {
    return THREE.MathUtils.clamp(Math.floor(value), 0, 10);
  }
}

/** Grid subdivision depths are bounded to avoid impractical coordinate ranges. */
