import * as THREE from 'three';
import { BenchmarkMetricType } from '../enums/BenchmarkMetricType';
import { StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import {
  Fn, If, Loop, clamp, float, floor, instanceIndex, ivec3, max, min, mix, storage, uint, uniform, vec3, vec4,
} from 'three/tsl';
import type { GPUParticleBufferState, GPUParticleLike, GPUParticleUpdateContext } from '../simulation/gpu/Particle';
import ParticleSpatialGrid, { type ParticleSpatialGridRenderer } from '../spatial/structures/ParticleSpatialGrid';
import StagedGPUAllocation from '../utils/gpu/StagedGPUAllocation';
import prepareComputePrograms from '../utils/gpu/prepareComputePrograms';
import type { SpatialGridDomain } from '../spatial/structures/spatialGridDomain.utils';
import { copyStorageAttributes, initializeStorageAttribute } from '../utils/gpu/storage.utils';
import FluidReduction from '../simulation/gpu/FluidReduction';
import Collision from './Collision';
import FluidPressureProjection, { type FluidPressureCapacityStorage } from '../simulation/gpu/FluidPressureProjection';
import { releaseSharedStorage } from '../utils/gpu/sharedStorage.utils';
import { initialFluidQuality } from '../simulation/gpu/fluidStartup.utils';
import SparseVolumeGrid from '../spatial/structures/gpu/SparseVolumeGrid';
import FluidSimulation, { type FluidSimulationOptions } from './FluidSimulation';
import type { SubSystemGPUCondition } from '../core/ParticleSystem';
import type { GPUSurfaceQuery } from '../spatial/surfaces/surfaceSample.types';
import {
  maximumFluidResidentCapacity, refinementResidentCapacity, coarsenedResidentCapacity,
} from '../simulation/gpu/fluidCapacity.utils';

/** Lightweight spray-source gates; child emission rate, ratio and lifetime stay on the subsystem. */
export interface FLIPSprayConditionOptions {
  /** Minimum particle speed in simulation units/second, including its speed multiplier. Defaults to 1. */
  minimumSpeed?: number;
  /** Minimum source age in seconds, preventing immediate emission from newborn liquid. Defaults to 0.05. */
  minimumAge?: number;
  /** Maximum other live particles in the search sphere. Defaults to 8; null disables isolation filtering. */
  maximumNeighbors?: number | null;
  /** Search radius as a multiple of largest absolute particle scale. Defaults to 2. */
  neighborRadius?: number;
}

/** Activity and local-support gates for ordinary surface-attached foam subsystems. */
export interface FLIPFoamConditionOptions extends FLIPSprayConditionOptions {
  /** Optional additional speed gate in simulation units/second. Defaults to 0; deformation is independent of speed. */
  minimumSpeed?: number;
  /** Minimum other live neighbors; excludes isolated airborne markers. Defaults to 3. */
  minimumNeighbors?: number;
  /** Minimum reconstructed symmetric strain in inverse seconds. Defaults to 0.5 with samplerGPU, otherwise 0. */
  minimumDeformity?: number;
  /** World-space surface query supplying deformation, shared with liquid surface shading. */
  samplerGPU?: GPUSurfaceQuery;
}

export interface FLIPSimulationOptions extends FluidSimulationOptions {
  picRatio: number;
  advectParticles: boolean;
  /** Swept boundary passes per frame. Additional passes resolve simultaneous contacts. */
  collisionIterations: number;
  /** Normalized strength of the bounded particle overlap position correction. */
  particleSeparation: number;
  /** Rest-distance multiplier applied to particle scale. */
  particleSpacing: number;
}

interface FlipPool {
  context: FLIPSimulation; grid: SparseVolumeGrid; attributes: StorageBufferAttribute[];
  projection?: FluidPressureProjection;
}

interface FlipCapacityPool {
  attributes: StorageBufferAttribute[];
  count: number;
  grid?: SparseVolumeGrid;
  pressure?: FluidPressureCapacityStorage;
  retired: StorageBufferAttribute[];
  adopted?: boolean;
}

class FLIPSimulation extends FluidSimulation {
  /** Selects active, partly supported liquid markers. Unlike spray, isolated markers are excluded.
   * This is a local-support free-surface heuristic, not a persistent foam field or a whitewater solver. */
  static FoamCondition(options: FLIPFoamConditionOptions = {}): SubSystemGPUCondition {
    const minimumNeighbors = options.minimumNeighbors ?? 3;
    const maximumNeighbors = options.maximumNeighbors ?? 22;
    const neighborRadius = options.neighborRadius ?? 2;
    const minimumDeformity = options.minimumDeformity ?? (options.samplerGPU ? 0.5 : 0);

    if (!Number.isFinite(minimumDeformity) || minimumDeformity < 0
      || minimumDeformity > 0 && !options.samplerGPU) {
      throw new RangeError('FoamCondition requires nonnegative minimumDeformity and a samplerGPU for deformation.');
    }
    if (!Number.isInteger(minimumNeighbors) || minimumNeighbors < 0
      || !Number.isInteger(maximumNeighbors) || maximumNeighbors < minimumNeighbors) {
      throw new RangeError('FoamCondition requires ordered, nonnegative integer neighbor limits.');
    }
    const activity = FLIPSimulation.SprayCondition({ ...options, minimumSpeed: options.minimumSpeed ?? 0,
      minimumAge: options.minimumAge ?? 0.1, maximumNeighbors: null, neighborRadius });
    const condition: SubSystemGPUCondition = (particle, dt, context) => {
      const selected = activity(particle, dt, context).toVar();
      if (minimumDeformity > 0 && options.samplerGPU) {
        const toWorld = uniform(context.system.getSimulationToWorldMatrix())
          .onFrameUpdate(() => context.system.getSimulationToWorldMatrix());

        If(selected, () => {
          const sample = options.samplerGPU!(toWorld.mul(vec4(particle.position, 1)).xyz);
          if (!sample.deformation) throw new Error('FoamCondition samplerGPU must supply surface deformation.');
          selected.assign(sample.valid.and(sample.deformation.greaterThanEqual(minimumDeformity)));
        });
      }

      const grid = context.spatialGrid;
      if (!grid) throw new Error('FoamCondition requires its managed parent particle spatial grid.');
      If(selected, () => {
        const count = uint(0).toVar();
        const radius = max(particle.scale.x.abs(), max(particle.scale.y.abs(), particle.scale.z.abs()))
          .mul(neighborRadius).max(1e-5);
        grid.forEachParticleInRadius(particle.position, radius, neighbor => {
          If(neighbor.index.notEqual(particle.index).or(neighbor.generation.notEqual(particle.generation)),
            () => count.addAssign(1));
        });
        selected.assign(count.greaterThanEqual(minimumNeighbors).and(count.lessThanEqual(maximumNeighbors)));
      });
      return selected;
    };
    condition.spatialGridOptions = { brickSubdivisions: 3, cellSubdivisions: 1, maxQuerySteps: 0, timeQuality: 1 };
    return condition;
  }

  /** Selects fast, sparsely surrounded source particles without sampling an Eulerian fluid field.
   * Inspired by energy/air-entrainment source controls, not a complete whitewater model.
   * Neighborhoods use current parent positions, even when testing a captured event.
   * No FLIP module is required; this predicate also works on other GPU particle sources. */
  static SprayCondition(options: FLIPSprayConditionOptions = {}): SubSystemGPUCondition {
    const minimumSpeed = options.minimumSpeed ?? 1;
    const minimumAge = options.minimumAge ?? 0.05;
    const maximumNeighbors = options.maximumNeighbors === undefined ? 8 : options.maximumNeighbors;
    const neighborRadius = options.neighborRadius ?? 2;
    if (!Number.isFinite(minimumSpeed) || minimumSpeed < 0
      || !Number.isFinite(minimumAge) || minimumAge < 0
      || !Number.isFinite(neighborRadius) || neighborRadius <= 0
      || (maximumNeighbors !== null && (!Number.isInteger(maximumNeighbors) || maximumNeighbors < 0))) {
      throw new RangeError('SprayCondition requires nonnegative speed/age/count and a finite positive radius.');
    }
    const condition: SubSystemGPUCondition = (particle, _dt, context) => {
      const eligible = particle.velocity.length().mul(particle.speed.abs()).greaterThanEqual(minimumSpeed)
        .and(particle.realtime.greaterThanEqual(minimumAge * 1000)).toVar();
      if (maximumNeighbors !== null) {
        const grid = context.spatialGrid;
        if (!grid) throw new Error('SprayCondition isolation requires its managed parent spatial grid.');
        If(eligible, () => {
          const radius = max(particle.scale.x.abs(), max(particle.scale.y.abs(), particle.scale.z.abs()))
            .mul(neighborRadius).max(1e-5);
          const neighbors = uint(0).toVar();
          grid.forEachParticleInRadius(particle.position, radius, neighbor => {
            // Event slots may have been reused: exclude only the source identity.
            If(neighbor.index.notEqual(particle.index).or(neighbor.generation.notEqual(particle.generation)), () => {
              neighbors.addAssign(1);
            });
          });
          eligible.assign(neighbors.lessThanEqual(maximumNeighbors));
        });
      }
      return eligible;
    };
    if (maximumNeighbors !== null) condition.spatialGridOptions = {
      brickSubdivisions: 3, cellSubdivisions: 1, maxQuerySteps: 0, timeQuality: 1,
    };
    return condition;
  }

  picRatio: number;
  advectParticlesEnabled: boolean;
  private _particleSeparation = 0;
  private _particleSpacing = 0;
  private _collisionIterations = 0;
  private boundaryCollisions: Collision[] = [];
  private transferReduction?: FluidReduction;
  private transferReductionCapacity = 0;
  private readonly transferReductionKeys = new WeakMap<object, object[]>();
  private transferReadPending = false;
  private clearNewPressureNode?: ComputeNode;
  private gatherNode?: ComputeNode;
  private forceNodeCompute?: ComputeNode;
  private transferNode?: ComputeNode;
  private separationNode?: ComputeNode;
  private separationApplyNode?: ComputeNode;
  private separationAttribute?: StorageBufferAttribute;
  private separationPositions?: { element(index: Node | number): Node<'vec4'> };
  private velocityBeforeAttribute?: StorageBufferAttribute;
  private velocityBefore?: { element(index: Node | number): Node<'vec4'> };
  private gatherCacheKey = '';
  private gatherBuffers?: GPUParticleBufferState;
  private gatherGrid?: ParticleSpatialGrid;
  private pressureProjection?: FluidPressureProjection;
  private readonly picRatioNode = uniform(0);
  private workGrid?: SparseVolumeGrid;
  private workPool?: StagedGPUAllocation<FlipCapacityPool>;
  private requiredBrickCapacity = 0;
  private allocationReadPending = false;
  private allocationFrame = 0;
  private simulationStep = 0;
  private initialQualitySelected = false;
  private clearFieldsNode?: ComputeNode;
  private resetFields = true;
  private resetNodes?: { velocity: StorageBufferAttribute; pressure: StorageBufferAttribute; nodes: ComputeNode[] };
  private movingWallsNode?: ComputeNode;
  private movingWallsKey = '';

  constructor(options: Partial<FLIPSimulationOptions> = {}) {
    super({
      ...options,
      automaticPadding: options.automaticPadding ?? true,
    });
    this.picRatio = THREE.MathUtils.clamp(options.picRatio ?? 0.05, 0, 1);
    this.advectParticlesEnabled = options.advectParticles ?? false;
    this.particleSeparation = THREE.MathUtils.clamp(options.particleSeparation ?? 0.05, 0, 1);
    this.particleSpacing = Math.max(0, options.particleSpacing ?? 1);
    this.usesParticleColliderSweeps = true;
    this.modifyGPU = () => {};
    this.collisionIterations = options.collisionIterations ?? 2;
    this.createWorkGrid();
    for (const [name, get] of Object.entries({
      residentCapacity: () => this.workGrid?.capacity ?? 0,
      allocatedCells: () => this.workGrid?.cellCount ?? 0,
    })) this.benchmarks.register(name, { type: BenchmarkMetricType.Gauge, unit: 'count', get });
  }

  get particleSeparation(): number {
    return this._particleSeparation;
  }

  set particleSeparation(value: number) {
    const next = THREE.MathUtils.clamp(Number.isFinite(value) ? value : 0, 0, 1);
    if (next === this._particleSeparation) return;
    this._particleSeparation = next;
    this.separationNode = undefined;
    this.needsUpdate = true;
  }

  get particleSpacing(): number {
    return this._particleSpacing;
  }

  set particleSpacing(value: number) {
    const next = Number.isFinite(value) ? Math.max(0, value) : 0;
    if (next === this._particleSpacing) return;
    this._particleSpacing = next;
    this.gatherNode = undefined;
    this.separationNode = undefined;
    this.needsUpdate = true;
  }

  get collisionIterations(): number {
    return this._collisionIterations;
  }

  set collisionIterations(value: number) {
    const next = Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
    if (next === this._collisionIterations) return;
    this.dependents = this.dependents.filter((module) => (
      !this.boundaryCollisions.includes(module as Collision)
    ));
    this.boundaryCollisions = Array.from({ length: next }, () => (
      new Collision({
        backend: this.particleCollisionBackend,
        bounce: 0,
        dampen: 0,
        radiusScale: 1,
        radiusOffset: this.particleCollisionThicknessValue,
      })
    ));
    this.dependents.push(...this.boundaryCollisions);
    this._collisionIterations = next;
    this.needsUpdate = true;
  }

  protected override get gridFieldCellCount(): number { return 1; }

  private createWorkGrid(capacity?: number): void {
    if (this.workGrid) return;
    const side = 2 ** this.spatialGridOptions!.cellSubdivisions!;
    const logical = this.gridDimensions.x * this.gridDimensions.y * this.gridDimensions.z / side ** 3;
    const limit = Math.floor((128 * 1024 * 1024 - 32) / (side ** 3 * 32));
    this.workGrid = new SparseVolumeGrid({ ...this.spatialGridOptions, bounds: this.bounds },
      capacity ?? Math.max(1, Math.min(logical, 2 ** (3 * this.spatialGridOptions!.brickSubdivisions!), limit)),
      this.gridDimensions);
    this.resizeGridFields(this.workGrid.cellCount);
    this.initializeTransferFields();
  }

  private pressureScratchSource?: FluidPressureProjection;

  private liveContext?: GPUParticleUpdateContext;
  private qualityPreparation?: {
    key: string; ready: boolean; buffers: GPUParticleBufferState; pool?: FlipPool; completion?: Promise<void>;
    phase?: string;
  };
  private qualityPreparationError?: string;

  /** Compile replacement transfer/pressure programs before allowing an automatic tier switch. */
  protected override prepareQualityChange(domain: SpatialGridDomain, renderer: ParticleSpatialGridRenderer): boolean {
    const context = this.liveContext, grid = this.spatialGrid;
    if (!context || !grid) return false;
    const key = [domain.cellSize, context.buffers.version, this.pressureIterations,
      this.collisionIterations, grid.resourceVersion, ...this.boundsLimit.toArray()].join(':');
    const pending = this.qualityPreparation;
    if (pending?.key === key && pending.buffers === context.buffers) {
      if (!pending.ready || !pending.pool) return false;
      if (!pending.pool.grid.ensureDirectory(renderer, domain.gridDimensions)) return false;
      pending.pool.grid.setLayoutMetadata(domain.bounds, domain.gridDimensions);
      pending.pool.context.gridDimensions.copy(domain.gridDimensions);
      return true;
    }
    this.cancelQualityPreparation();
    const candidate: NonNullable<FLIPSimulation['qualityPreparation']> = {
      key, ready: false, buffers: context.buffers,
    };
    this.qualityPreparation = candidate;
    const started = performance.now();
    this.benchmarks.set('qualityPreparationStartedAt', started);
    this.benchmarks.set('qualityPreparationReadyAt', null);
    this.benchmarks.set('qualityPreparationMs', null);
    // Capacity admission keeps priority. Wait for its compiler/adoption instead of canceling needed growth.
    const capacityPool = this.workPool;
    candidate.completion = Promise.resolve(capacityPool?.whenPrepared()).then(async () => {
      while (capacityPool === this.workPool && this.qualityPreparation === candidate
        && ['preparing', 'ready'].includes(capacityPool?.status.state ?? '')) {
        await capacityPool?.whenPrepared();
        await new Promise(resolve => setTimeout(resolve, 4));
      }
      if (this.qualityPreparation !== candidate) return;
      candidate.phase = 'allocation';
      const side = 2 ** this.spatialGridOptions!.cellSubdivisions!;
      const nativeMaximum = Math.floor(((renderer.backend as { device: {
        limits: { maxStorageBufferBindingSize: number };
      } }).device.limits.maxStorageBufferBindingSize - 32) / (side ** 3 * 32));
      const maximum = maximumFluidResidentCapacity(this.boundsLimit, domain.cellSize * side, nativeMaximum);
      let capacity = Math.min(this.workGrid!.capacity, maximum);
      if (domain.cellSize > this.workGrid!.cellSize) {
        const source = this.workGrid!, directory = source.directoryCapacity, reserved = source.capacity;
        const dimensions = source.gridDimensions.clone().divideScalar(source.brickSide);
        const minimum = source.bounds.min.clone(), brick = source.brickSize;
        const pages = new Uint32Array(await renderer.getArrayBufferAsync(source.pagesAttribute));
        if (this.qualityPreparation !== candidate) return;
        if (source !== this.workGrid || source.capacity !== reserved) {
          this.qualityPreparation = undefined;
          return;
        }
        capacity = coarsenedResidentCapacity(pages.subarray(directory, directory + reserved), dimensions,
          minimum, brick, domain.gridDimensions.clone().divideScalar(side),
          domain.bounds.min, domain.cellSize * side, maximum);
      }
      if (domain.cellSize < this.workGrid!.cellSize) {
        candidate.phase = 'refinement demand';
        const diagnostics = new Uint32Array(await renderer.getArrayBufferAsync(this.workGrid!.diagnosticsAttribute));
        if (this.qualityPreparation !== candidate) return;
        capacity = refinementResidentCapacity(this.workGrid!.capacity, diagnostics[0],
          this.workGrid!.cellSize / domain.cellSize,
          domain.gridDimensions.x * domain.gridDimensions.y * domain.gridDimensions.z / side ** 3, maximum);
      }
      const volume = new SparseVolumeGrid({ ...this.spatialGridOptions, bounds: domain.bounds },
        capacity, domain.gridDimensions);
      volume.reductionCellCount = nativeMaximum * volume.cellsPerBrick + 1;
      const target = this.forkGridResources(volume.cellCount);
      Object.defineProperty(target, 'gridDimensions', { value: domain.gridDimensions.clone() });
      target.workGrid = volume; target.workPool = undefined; target.qualityPreparation = undefined;
      target.velocityBeforeAttribute = undefined; target.velocityBefore = undefined;
      target.initializeTransferFields();
      target.pressureProjection = undefined; target.pressureScratchSource = this.pressureProjection;
      target.clearFieldsNode = undefined;
      target.clearNewPressureNode = undefined; target.resetFields = false; target.resetNodes = undefined;
      target.gatherNode = undefined; target.forceNodeCompute = undefined; target.transferNode = undefined;
      target.separationNode = undefined; target.separationApplyNode = undefined; target.gatherCacheKey = '';
      target.pollWorkCapacity = () => {}; target.measureTransfer = () => {};
      candidate.pool = { context: target, grid: volume, attributes: target.fieldAttributes };
      candidate.phase = 'storage';
      for (const attribute of candidate.pool.attributes) {
        if (this.qualityPreparation !== candidate) return;
        initializeStorageAttribute(renderer, attribute, false);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const nodes: ComputeNode[] = [], compute = renderer.compute;
      candidate.phase = 'graphs';
      renderer.compute = value => nodes.push(...(Array.isArray(value) ? value : [value]));
      try {
        target.getPressureProjection().forPreparation(() => target.computeTransfer(context, renderer, grid));
        target.appendBoundaryPrograms(nodes);
      } finally { renderer.compute = compute; }
      candidate.pool.projection = target.pressureProjection;
      candidate.phase = 'compilation';
      await prepareComputePrograms(renderer, nodes, () => this.qualityPreparation === candidate, this.benchmarks);
      if (this.qualityPreparation !== candidate) return;
      // forPreparation suppresses live reductions. Compile those pressure variants explicitly
      // as well, so the first adopted solve cannot create its diagnostic/velocity pipelines.
      candidate.phase = 'pressure compilation';
      await target.getPressureProjection().prepare(renderer, target.velocityNext, target.velocityCurrent,
        target.pressureIterations, target.velocityBefore, this.benchmarks);
      if (this.qualityPreparation !== candidate) return;
      candidate.ready = true;
      candidate.phase = 'ready';
      this.benchmarks.set('qualityPreparationReadyAt', performance.now());
      this.benchmarks.set('qualityPreparationMs', performance.now() - started);
    }).catch(cause => {
      this.qualityPreparationError = cause instanceof Error ? cause.message : String(cause);
      this.benchmarks.increment('qualityPreparationFailures');
      // Keep the live tier usable if background preparation fails; explicit edits still use the cold path.
      if (this.qualityPreparation === candidate) this.qualityPreparation = undefined;
    }).finally(() => {
      if (this.qualityPreparation !== candidate && candidate.pool) this.disposePreparedQuality(candidate.pool);
    });
    return false;
  }

  private disposePreparedQuality(pool: FlipPool): void {
    pool.attributes.forEach(attribute => attribute.dispose());
    pool.projection?.dispose(); pool.grid.dispose();
  }

  private cancelQualityPreparation(): void {
    const candidate = this.qualityPreparation;
    this.qualityPreparation = undefined;
    if (candidate?.ready && candidate.pool) {
      this.disposePreparedQuality(candidate.pool);
    }
  }

  protected override ensureGridResolution(renderer: ParticleSpatialGridRenderer, grid: ParticleSpatialGrid): void {
    const old = this.workGrid;
    const prepared = this.qualityPreparation;
    if (old && prepared?.ready && prepared.pool
      && Math.abs(prepared.pool.grid.cellSize - grid.cellSize) < 1e-9) {
      const pool = prepared.pool, attributes = this.fieldAttributes, projection = this.pressureProjection;
      this.qualityPreparation = undefined;
      const previousPreparation = this.workPool?.whenPrepared();
      this.workPool?.cancelPending(); this.workPool = undefined;
      this.adoptGridResources(pool.context);
      for (const key of ['workGrid', 'velocityBeforeAttribute', 'velocityBefore', 'pressureProjection',
        'clearFieldsNode', 'clearNewPressureNode', 'gatherNode', 'forceNodeCompute', 'transferNode',
        'separationNode', 'separationApplyNode', 'gatherCacheKey', 'gatherBuffers', 'gatherGrid'] as const) {
        (this as unknown as Record<string, unknown>)[key] = pool.context[key];
      }
      this.gridDimensions.copy(grid.gridDimensions); this.dimensionsNode.value.copy(this.gridDimensions);
      this.resolution = grid.cellsPerAxis; this.cellSize = grid.cellSize; this.cellSizeNode.value = grid.cellSize;
      this.pressureProjection?.updateTopology();
      // Fresh uploaded storage is already zero; avoid compiling an extra cold-clear program on adoption.
      this.resetFields = false;
      const device = (renderer.backend as { device: { queue: { onSubmittedWorkDone(): Promise<void> } } }).device;
      // An older capacity compiler may still reference the retired bindings, even after the GPU fence.
      void Promise.allSettled([previousPreparation, device.queue.onSubmittedWorkDone()]).then(() => {
        attributes.forEach(attribute => attribute.dispose()); projection?.dispose(); old.dispose(renderer);
        if (this.pressureProjection === pool.projection) pool.projection?.compactScratch(renderer);
      });
      return;
    }
    if (!old || old.maxDepth !== grid.maxDepth || old.brickSubdivisions !== grid.brickSubdivisions
      || Math.abs(old.cellSize - grid.cellSize) > 1e-9) {
      this.onGridResolutionChanged();
      this.gridDimensions.copy(grid.gridDimensions); this.dimensionsNode.value.copy(this.gridDimensions);
      this.cellSize = grid.cellSize; this.cellSizeNode.value = grid.cellSize;
      this.resolution = grid.cellsPerAxis;
      this.createWorkGrid();
      return;
    }
    const dimensionsChanged = !old.gridDimensions.equals(grid.gridDimensions);
    if (!old.updateLayout(renderer, this.bounds, grid.gridDimensions)) {
      const requested = this.bounds.clone();
      this.bounds.copy(old.bounds); this.boundsMinNode.value.copy(old.bounds.min);
      // Directory staging may defer coverage, but must not reinterpret old coverage as a quality request.
      // Doing so can adopt an unprepared coarser lattice and synchronously rebuild all pressure/transfer programs.
      grid.setBounds(grid.resolveBounds(old.bounds)); this.pendingBounds = { grid, bounds: requested };
      return;
    }
    this.gridDimensions.copy(grid.gridDimensions); this.dimensionsNode.value.copy(this.gridDimensions);
    if (dimensionsChanged) this.pressureProjection?.updateTopology();
  }

  protected override cellIndex(coordinate: Node<'ivec3'>): Node<'uint'> {
    return this.workGrid ? this.workGrid.index(coordinate) : super.cellIndex(coordinate);
  }

  protected override cellCoordinate(index: Node<'uint'>): Node<'ivec3'> {
    return this.workGrid ? this.workGrid.coordinate(index) : super.cellCoordinate(index);
  }

  private get fieldAttributes(): StorageBufferAttribute[] {
    return [this.velocityCurrentAttribute, this.velocityNextAttribute, this.pressureCurrentAttribute,
      this.divergenceAttribute, this.solidAttribute, this.boundaryAttribute];
  }

  private pollWorkCapacity(renderer: ParticleSpatialGridRenderer): void {
    if (this.allocationReadPending || ++this.allocationFrame % 16 !== 0 || !this.workGrid) return;
    this.allocationReadPending = true;
    const grid = this.workGrid;
    void renderer.getArrayBufferAsync(grid.diagnosticsAttribute).then(buffer => {
      if (grid !== this.workGrid) return;
      const values = new Uint32Array(buffer);
      this.benchmarks.set('residentPages', values[0]);
      this.benchmarks.set('deniedPages', values[1]);
      this.benchmarks.set('requestedPages', values[2]);
      this.benchmarks.set('activePages', values[5]);
      this.requiredBrickCapacity = this.capacityDemand(values[2], this.workPool?.metrics.preparationMs, grid.capacity);
    }).catch(() => {}).finally(() => { this.allocationReadPending = false; });
  }

  private ensureWorkPool(renderer: ParticleSpatialGridRenderer): void {
    const device = (renderer.backend as { device: { limits: { maxStorageBufferBindingSize: number };
      queue: { onSubmittedWorkDone(): Promise<void> } } }).device;
    const nativeMaximum = Math.floor((device.limits.maxStorageBufferBindingSize - 32)
      / (this.workGrid!.cellsPerBrick * 32));
    const maximum = Math.max(this.workGrid!.capacity,
      maximumFluidResidentCapacity(this.boundsLimit, this.workGrid!.brickSize, nativeMaximum));
    // Reserve reduction hierarchy structure once. Live dispatch sizes remain compact runtime counts.
    this.workGrid!.reductionCellCount = nativeMaximum * this.workGrid!.cellsPerBrick + 1;
    if (this.workPool?.maximumCapacity === maximum) return;
    this.workPool?.cancelPending();
    const pressure = this.getPressureProjection();
    this.workPool = new StagedGPUAllocation<FlipCapacityPool>({ attributes: this.fieldAttributes,
      count: this.cellCount, retired: [], adopted: true }, this.workGrid!.capacity, {
      maximumCapacity: maximum,
      create: capacity => {
        const volume = new SparseVolumeGrid({ ...this.spatialGridOptions, bounds: this.bounds },
          capacity, this.gridDimensions, this.workGrid!.directoryCapacity);
        const count = volume.cellCount;
        const attributes = this.fieldAttributes.map(attribute => new StorageBufferAttribute(
          new Float32Array(count * (attribute.count / this.cellCount) * attribute.itemSize), attribute.itemSize,
        ));
        return { grid: volume, attributes, count, pressure: pressure.createCapacityStorage(capacity), retired: [] };
      },
      prepare: async pool => {
        // Allocate backing in short slices; no live nodes, bindings, graphs or programs are changed here.
        const started = performance.now();
        let slice = started;
        for (const attribute of [...pool.attributes, ...pool.grid!.capacityAttributes, ...pool.pressure!.attributes]) {
          initializeStorageAttribute(renderer, attribute, false);
          if (performance.now() - slice >= 2) {
            await new Promise(resolve => setTimeout(resolve, 0));
            slice = performance.now();
          }
        }
        this.benchmarks.set('capacityStoragePreparationMs', performance.now() - started);
        this.benchmarks.set('capacityGraphConstructionMs', 0);
        this.benchmarks.set('capacityCompilationMs', 0);
      },
      canCommit: (_old, next) => {
        if (!pressure.canAdoptCapacityStorage(next.pressure!)) {
          this.requiredBrickCapacity = Math.max(this.requiredBrickCapacity, next.grid!.capacity);
          this.workPool!.cancelPending();
          return false;
        }
        return next.grid!.ensureDirectory(renderer, this.gridDimensions, this.workGrid!.directoryCapacity);
      },
      migrate: (old, next) => {
        old.attributes = this.fieldAttributes;
        old.count = this.cellCount;
        const count = this.cellCount - 1;
        copyStorageAttributes(renderer, old.attributes.flatMap((attribute, index) => {
          const target = next.attributes[index];
          if (attribute === this.velocityCurrentAttribute || attribute === this.boundaryAttribute) return [
            { source: attribute, target, byteLength: count * 16 },
            { source: attribute, target, sourceOffset: this.cellCount * 16,
              targetOffset: next.count * 16, byteLength: count * 16 },
          ];
          return [{ source: attribute, target, byteLength: count * attribute.itemSize * 4 }];
        }));
        this.workGrid!.migrateCapacity(renderer, next.grid!);
        pressure.migrateCapacityStorage(renderer, next.pressure!);
      },
      swap: next => {
        const previous = this.fieldAttributes;
        const replacements = new Map(previous.map((attribute, index) => [attribute, next.attributes[index]]));
        for (const node of [this.velocityCurrent, this.velocityNext, this.pressureCurrent,
          this.divergence, this.solid, this.faceOpenness]) {
          const binding = node as unknown as { value: StorageBufferAttribute };
          const attribute = replacements.get(binding.value);
          if (attribute) binding.value = attribute;
        }
        const names = ['velocityCurrentAttribute', 'velocityNextAttribute', 'pressureCurrentAttribute',
          'divergenceAttribute', 'solidAttribute', 'boundaryAttribute'] as const;
        names.forEach((key, index) => { this[key] = next.attributes[index]; });
        this.velocityBeforeAttribute = this.velocityCurrentAttribute;
        this.cellCount = next.count;
        this.fieldStrideNode.value = next.count;
        // Nodes, uniforms, indirect dispatch, boundary history and pressure warm start retain identity.
        const old = this.workPool!.current;
        old.retired.push(...this.workGrid!.adoptCapacity(next.grid!), ...pressure.adoptCapacityStorage(next.pressure!));
        next.grid!.dispatchAttributes.forEach(attribute => attribute.dispose());
        next.adopted = true;
      },
      dispose: pool => {
        const live = new Set(this.fieldAttributes);
        for (const attribute of new Set([...pool.attributes, ...pool.retired])) {
          if (!live.has(attribute)) releaseSharedStorage(attribute, renderer);
        }
        if (pool.grid && !pool.adopted) {
          pool.grid.dispose(renderer);
          pool.pressure?.attributes.forEach(attribute => releaseSharedStorage(attribute, renderer));
        }
      },
      fence: () => device.queue.onSubmittedWorkDone(),
    });
  }

  private initializeTransferFields(): void {
    if (!this.velocityBeforeAttribute) {
      this.velocityCurrentAttribute.dispose();
      this.velocityCurrentAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount * 8), 4);
      const packed = storage(this.velocityCurrentAttribute, 'vec4', this.cellCount * 2);
      this.velocityCurrent = packed;
      this.velocityBeforeAttribute = this.velocityCurrentAttribute;
      this.velocityBefore = { element: index => packed.element(
        typeof index === 'number' ? this.fieldStrideNode.add(index)
          : uint(index as Node<'uint'>).add(this.fieldStrideNode),
      ) };
    }
  }

  /** Predict startup coverage only; observed occupancy still controls all later tier requests. */
  protected selectInitialQuality(system: import('../core/ParticleSystem').default,
    renderer: ParticleSpatialGridRenderer): void {
    if (this.initialQualitySelected) return;
    this.initialQualitySelected = true;
    const grid = this.getParticleSpatialGrid(system)!;
    if (!this.autoBounds || !grid.autoVolumeQuality || system.liveParticleCount > 0) return;
    const limit = this.boundsLimit.toArray();
    let extent = limit.every(Number.isFinite) ? Math.max(...limit) : 0;
    if (!extent) {
      // Closed-volume colliders provide coverage evidence; ignore thin floors and walls.
      this.collectColliders(system);
      const toLocal = system.getSimulationToWorldMatrix().clone().invert();
      const support = new THREE.Box3();
      for (const collider of this.fluidColliders) {
        const geometry = collider.geometry;
        if (!geometry) continue;
        geometry.computeBoundingBox();
        if (!geometry.boundingBox) continue;
        collider.updateWorldMatrix(true, false);
        const box = geometry.boundingBox.clone().applyMatrix4(collider.matrixWorld).applyMatrix4(toLocal);
        const size = box.getSize(new THREE.Vector3()).toArray();
        if (Math.min(...size) > Math.max(...size) * 0.25) support.union(box);
      }
      for (const emitter of system.emitters) {
        emitter.source.geometry.computeBoundingBox();
        emitter.source.updateWorldMatrix(true, false);
        if (emitter.source.geometry.boundingBox) support.union(emitter.source.geometry.boundingBox.clone()
          .applyMatrix4(emitter.source.matrixWorld).applyMatrix4(toLocal));
      }
      if (!support.isEmpty()) extent = Math.max(...support.getSize(new THREE.Vector3()).toArray());
    }
    const previous = grid.volumeQualityTier;
    const quality = initialFluidQuality(extent, grid.minVolumeQuality, grid.maxVolumeQuality);
    grid.initializeVolumeQuality(quality);
    this.bounds.copy(grid.bounds); this.boundsMinNode.value.copy(this.bounds.min);
    this.ensureGridResolution(renderer, grid);
    this.benchmarks.set('initialQualityReference', grid.volumeQualityTier);
    this.benchmarks.set('initialQualityPreviousReference', previous);
    this.benchmarks.set('initialQualityPredictedExtent', extent);
    this.benchmarks.set('initialQualityCellWidth', grid.cellSize);
  }

  public override async prepareResources(
    system: import('../core/ParticleSystem').default,
    renderer: ParticleSpatialGridRenderer,
  ): Promise<void> {
    this.selectInitialQuality(system, renderer);
    this.createWorkGrid();
    this.ensureWorkPool(renderer);
    this.workGrid!.updateDispatch(renderer);
    await this.workGrid!.prepareLayout(renderer);
    this.initializeTransferFields();
    await super.prepareResources(system, renderer);
    // Dependents are visited before their owner during system preparation. The shared collider
    // backend only becomes ready in the owner, so prepare its collision variants now.
    for (const collision of this.boundaryCollisions) {
      await collision.prepareResources(system, renderer as import('three/webgpu').WebGPURenderer);
    }
    await this.getPressureProjection().prepare(
      renderer, this.velocityNext, this.velocityCurrent, this.pressureIterations, this.velocityBefore, this.benchmarks,
    );
    await this.prepareGuardResources(system, renderer);

    // Capture the populated transfer path against persistent particle/index bindings. Compilation
    // must not emit particles, retire pages, reset pressure, or advance collider history.
    const context = system.gpuSimulation.prepareContext(renderer as import('three/webgpu').WebGPURenderer);
    const grid = this.getParticleSpatialGrid(system)!;
    grid.initialize(renderer, context.buffers);
    const nodes: ComputeNode[] = [], compute = renderer.compute;
    const reset = this.resetFields;
    const poll = this.pollWorkCapacity, measure = this.measureTransfer;
    this.pollWorkCapacity = () => {};
    this.measureTransfer = () => {};
    renderer.compute = value => nodes.push(...(Array.isArray(value) ? value : [value]));
    try {
      super.computeGPU(context, renderer, grid);
      this.getPressureProjection().forPreparation(() => this.computeTransfer(context, renderer, grid));
      this.appendBoundaryPrograms(nodes);
      measure.call(this, context, renderer, false, true);
      measure.call(this, context, renderer, true, true);
    } finally {
      renderer.compute = compute;
      this.resetFields = reset;
      this.pollWorkCapacity = poll;
      this.measureTransfer = measure;
    }
    await prepareComputePrograms(renderer, [...new Set(nodes)], () => true, this.benchmarks);
  }

  /** Internal debug-grid access, not part of the public module contract. @internal */
  protected override get visualizationGrid(): SparseVolumeGrid | undefined { return this.workGrid; }

  public override computeGPU(
    context: GPUParticleUpdateContext,
    renderer: ParticleSpatialGridRenderer,
    grid?: ParticleSpatialGrid,
  ): void {
    if (!grid) throw new Error('FLIPSimulation requires a GPU spatial grid.');
    this.liveContext = context;
    super.computeGPU(context, renderer, grid);
    this.picRatioNode.value = THREE.MathUtils.clamp(this.picRatio, 0, 1);
    this.ensureGridResolution(renderer, grid);
    this.refreshBounds(grid, renderer);
    this.benchmarks.span('particleCollision', () => this.computeMovingWalls(context, renderer, grid));
    this.simulationStep++;
    this.ensureWorkPool(renderer);
    this.workPool!.commit();
    if (this.requiredBrickCapacity > 0) {
      this.workPool!.request(Math.min(this.requiredBrickCapacity, this.workPool!.maximumCapacity));
    }
    this.requiredBrickCapacity = 0;
    this.computeTransfer(context, renderer, grid);
    if (this.showGridHelper) this.workGrid!.updateVisualization(renderer, this.velocityCurrent, float(1.5), 'w');
    this.updateBoundsHelper(context.system);
  }

  private computeTransfer(context: GPUParticleUpdateContext, renderer: ParticleSpatialGridRenderer,
    grid: ParticleSpatialGrid): void {
    const tagMask = context.system.getGPUFilterTagMask(this.tags);
    this.initializeTransferFields();
    const clearFields = (index: Node<'uint'>) => {
      this.velocityCurrent.element(index).assign(vec4(0));
      this.velocityNext.element(index).assign(vec4(0));
      this.velocityBefore!.element(index).assign(vec4(0));

      this.divergence.element(index).assign(0);
    };
    if (this.resetFields) {
      // Ordinary updates also support a cold grid without an explicit system.prepare() call.
      this.workGrid!.updateDispatch(renderer);
      if (this.resetNodes?.velocity !== this.velocityCurrentAttribute
        || this.resetNodes.pressure !== this.pressureCurrentAttribute) {
        this.resetNodes?.nodes.forEach(node => node.dispose());
        this.resetNodes = { velocity: this.velocityCurrentAttribute, pressure: this.pressureCurrentAttribute, nodes: [
          Fn(() => clearFields(instanceIndex))().compute(this.cellCount),
          Fn(() => { this.pressureCurrent.element(instanceIndex).assign(0); })().compute(this.cellCount),
        ] };
      }
      renderer.compute(this.resetNodes.nodes);
      this.resetFields = false;
    }
    this.clearFieldsNode ??= this.computeCells(clearFields);
    // Clear old addresses before page reassignment, including retired bricks.
    renderer.compute(this.clearFieldsNode);
    this.pressureProjection?.clearPreviousFaces(renderer);
    this.benchmarks.span('brickActivation', () => this.workGrid!.rebuild(
      context, renderer, undefined, undefined, this.boundsMinNode, this.cellSizeNode,
      float(0), tagMask, undefined, 3, undefined, this.simulationStep,
    ));
    this.pollWorkCapacity(renderer);
    // Stable resident addresses retain pressure; newly activated bricks must not
    // inherit the pressure of an earlier, retired liquid region.
    this.clearNewPressureNode ??= this.workGrid!.compute(index => {
      const coordinate = this.workGrid!.coordinate(index);
      this.pressureCurrent.element(this.cellIndex(coordinate)).assign(0);
    }, false, true);
    renderer.compute(this.clearNewPressureNode);
    this.computeSolidField(context, renderer);

    const cacheKey = [grid.resourceVersion, context.buffers.version, tagMask].join('|');
    if (cacheKey !== this.gatherCacheKey || this.gatherBuffers !== context.buffers || this.gatherGrid !== grid) {
      this.gatherCacheKey = cacheKey;
      this.gatherBuffers = context.buffers;
      this.gatherGrid = grid;
      this.gatherNode = undefined;
      this.transferNode = undefined;
      this.separationNode = undefined;
      this.separationApplyNode = undefined;
    }

    this.measureTransfer(context, renderer, false);
    const gather = this.gatherNode ?? this.computeCells(index => {
      const coordinate = this.cellCoordinate(index);
      const center = this.cellCenter(coordinate);
      const radius = this.cellSizeNode.mul(1.5);
      const momentum = vec3(0).toVar('flipMomentum');
      const momentumBefore = vec3(0).toVar('flipMomentumBefore');
      const totalMass = float(0).toVar('flipMass');
      const totalVolume = float(0).toVar('flipVolume');
      const fluidCell = float(0).toVar('flipFluidCell');
      grid.forEachParticleInRadius(center, radius, (particle, distanceSq) => {
        const halfCell = this.cellSizeNode.mul(0.5);
        const containsMarker = particle.position.greaterThanEqual(center.sub(halfCell)).all()
          .and(particle.position.lessThan(center.add(halfCell)).all());
        fluidCell.assign(max(fluidCell, containsMarker.select(1, 0)));
        const weight = max(float(0), float(1).sub(distanceSq.sqrt().div(radius)));
        const mass = max(particle.mass, float(0)).mul(weight);
        const gravityModifier = this.evaluateDynamicGPU.number(
          'gravityModifier.flip', () => context.system.gravityModifier,
          particle.time, 0, particle.index,
        );
        const gravityStep = context.gravityNode.mul(context.deltaTimeNode.mul(gravityModifier));
        momentumBefore.addAssign(particle.velocity.mul(mass));
        momentum.addAssign(particle.velocity.add(gravityStep).mul(mass));
        totalMass.addAssign(mass);
        const spacing = max(
          particle.scale.x.abs(), max(particle.scale.y.abs(), particle.scale.z.abs()),
        ).mul(this.particleSpacing);
        totalVolume.addAssign(spacing.mul(spacing).mul(spacing).mul(weight)
          .mul(particle.mass.greaterThan(0).select(1, 0)));
      }, { tagMask });
      // Marker centers undersample fine grids: reconstructed bulk support must
      // not become zero-pressure air just because this cell has no marker center.
      const volumeFraction = totalVolume.div(radius.mul(radius).mul(radius).mul(Math.PI / 3));
      const liquid = fluidCell.greaterThan(0).or(volumeFraction.greaterThanEqual(0.5));
      this.velocityCurrent.element(index).assign(
        // Packed occupancy: 2 contains a marker, 1 is velocity support, 0 is empty.
        vec4(momentum.div(max(totalMass, float(1e-6))),
          totalMass.greaterThan(1e-6).select(liquid.select(2, 1), 0)),
      );
      this.velocityBefore!.element(index).assign(
        vec4(
          momentumBefore.div(max(totalMass, float(1e-6))),
          totalMass.greaterThan(1e-6).select(
            // Integral of the radial cone kernel: pi * radius^3 / 3.
            volumeFraction.max(1e-6),
            0,
          ),
        ),
      );
    });
    gather.setName('rzmps.flip.particleToGrid');
    this.gatherNode = gather;
    this.benchmarks.span('particleToGrid', () => renderer.compute(gather));

    const force = this.forceNodeCompute ?? this.computeCells(index => {
      const velocity = vec3(this.velocityCurrent.element(index).xyz);
      // Mask after gather to stay within its eight-storage-buffer budget.
      // Both transfer fields must exclude the same solid donors.
      If(this.isSolid(index), () => {
        this.velocityBefore!.element(index).assign(vec4(0));
      });
      this.velocityNext.element(index).assign(this.isSolid(index).select(
        vec4(0),
        vec4(
          this.clampVelocity(velocity.add(this.forceNode.mul(context.deltaTimeNode))),
          this.velocityCurrent.element(index).w,
        ),
      ));
    });
    this.forceNodeCompute = force;
    this.benchmarks.span('gridForces', () => renderer.compute(force));
    this.solveProjection(renderer, this.velocityNext, this.velocityCurrent);

    const transfer = this.transferNode ?? Fn(() => {
      const particle = context.buffers.storage.createParticle(undefined, true);
      If(particle.alive.notEqual(uint(0)), () => this.gridToParticleGPU(
        particle,
        context,
      ));
      context.buffers.storage.storeParticle(particle);
    })().compute(context.buffers.count);
    transfer.setName('rzmps.flip.gridToParticle');
    this.transferNode = transfer;
    this.benchmarks.span('gridToParticle', () => renderer.compute(transfer));
    this.measureTransfer(context, renderer, true);

    if (this.particleSeparation > 0 && this.particleSpacing > 0) {
      if (this.separationAttribute?.count !== context.buffers.capacity) {
        this.separationAttribute?.dispose();
        this.separationAttribute = new StorageBufferAttribute(
          new Float32Array(context.buffers.capacity * 4), 4,
        );
        this.separationPositions = storage(
          this.separationAttribute, 'vec4', context.buffers.capacity,
        );
        this.separationNode = undefined;
        this.separationApplyNode = undefined;
      }
      const separation = this.separationNode ?? Fn(() => {
        const particle = context.buffers.storage.createParticle(undefined, true);
        const separatedPosition = particle.position.toVar('flipSeparatedPosition');
        If(particle.alive.notEqual(uint(0)).and(this.isInsideCap(particle.position)), () => {
          const diameter = max(
            particle.scale.x.abs(),
            max(particle.scale.y.abs(), particle.scale.z.abs()),
          );
          const searchRadius = max(diameter, grid.getMaxParticleRadiusNode().mul(2))
            .mul(this.particleSpacing).max(1e-5);
          const correction = vec3(0).toVar('flipParticleSeparation');
          grid.forEachParticleInRadius(
            particle.position,
            searchRadius,
            (neighbor, distanceSquared) => {
              const offset = vec3(particle.position.sub(neighbor.position));
              const neighborDiameter = max(neighbor.scale.x.abs(),
                max(neighbor.scale.y.abs(), neighbor.scale.z.abs()));
              const pairDistance = diameter.add(neighborDiameter).mul(0.5 * this.particleSpacing);
              const distance = distanceSquared.sqrt();
              const overlap = pairDistance.sub(distance).max(0);
              // Coincident pairs need a stable antisymmetric direction, not a
              // zero vector. Both particles see the same hash and opposite signs.
              const ordered = particle.index.lessThan(neighbor.index);
              const low = ordered.select(particle.index, neighbor.index);
              const high = ordered.select(neighbor.index, particle.index);
              const hash = uint(low.mul(73856093)).bitXor(uint(high.mul(19349663)));
              const fallback = vec3(hash.bitAnd(1023), hash.shiftRight(10).bitAnd(1023),
                hash.shiftRight(20).bitAnd(1023)).div(511.5).sub(1).normalize()
                .mul(particle.index.lessThan(neighbor.index).select(1, -1));
              const direction = distance.greaterThan(1e-5).select(offset.div(distance.max(1e-5)), fallback);
              correction.addAssign(direction.mul(overlap).mul(0.5));
            },
            { excludeIndex: particle.index, tagMask },
          );
          If(correction.lengthSq().greaterThan(0), () => {
            const displacement = vec3(correction
              .mul(this.particleSeparation));
            const distance = displacement.length().max(1e-5);
            const maxDisplacement = diameter.mul(0.1);
            displacement.mulAssign(min(float(1), maxDisplacement.div(distance)));
            separatedPosition.assign(particle.position.add(displacement));
          });
        });
        this.separationPositions!.element(instanceIndex).assign(vec4(separatedPosition, 0));
      })().compute(context.buffers.count);
      separation.setName('rzmps.flip.separation');
      this.separationNode = separation;
      // Commit after every neighbor query has finished reading the original positions.
      const apply = this.separationApplyNode ?? Fn(() => {
        const particle = context.buffers.storage.createParticle(undefined, true);
        If(particle.alive.notEqual(uint(0)), () => {
          const targetPosition = this.separationPositions!.element(instanceIndex).xyz;
          if (this.hasParticleColliderGeometry) {
            const radius = max(
              particle.scale.x.abs(),
              max(particle.scale.y.abs(), particle.scale.z.abs()),
            ).mul(0.5).add(this.particleCollisionThickness);
            const hit = this.queryParticleCollider(
              transformPointGPU(particle.position, context.simulationToWorldNode),
              transformPointGPU(targetPosition, context.simulationToWorldNode),
              radius,
            );
            If(hit.get('found') as Node<'bool'>, () => {
              const normal = (hit.get('normal') as Node<'vec3'>).normalize();
              const distance = (hit.get('distanceSq') as Node<'float'>).sqrt();
              const contact = hit.get('capsulePoint') as Node<'vec3'>;
              const remaining = transformPointGPU(targetPosition, context.simulationToWorldNode).sub(contact);
              // A contact at the start of a sweep must not discard tangential
              // separation: markers resting on a wall still need room to spread.
              const tangent = remaining.sub(normal.mul(min(remaining.dot(normal), float(0))));
              const position = contact.add(normal.mul(radius.sub(distance).max(0))).add(tangent);
              particle.position.assign(transformPointGPU(position, context.worldToSimulationNode));
            }).Else(() => {
              particle.position.assign(targetPosition);
            });
          } else {
            particle.position.assign(targetPosition);
          }
          context.buffers.storage.storeParticle(particle);
        });
      })().compute(context.buffers.count);
      apply.setName('rzmps.flip.separationCollision');
      this.separationApplyNode = apply;
      // Grid advection may have moved markers since the system built the hash.
      if (this.advectParticlesEnabled) {
        this.benchmarks.span('particleSpatialIndex', () => grid.rebuild(renderer, context.buffers, {}));
      }
      this.benchmarks.span('separation', () => {
        renderer.compute(separation);
        renderer.compute(apply);
      });
    }
  }

  protected override onBoundsChanged(previous: THREE.Box3): void {
    void previous;
    // A changed outer pressure boundary invalidates the previous pressure gauge.
    this.pressureProjection?.invalidate();
  }

  protected override onBoundaryChanged(): void {
    this.pressureProjection?.invalidate();
    this.resetFields = true;
  }

  protected override onParticleStateReset(): void {
    this.cancelQualityPreparation();
    this.resetFields = true;
    this.pressureProjection?.invalidate();
  }

  private measureTransfer(
    context: GPUParticleUpdateContext,
    renderer: ParticleSpatialGridRenderer,
    after: boolean,
    preparing = false,
  ): void {
    if (!this.benchmarks.enabled || (!preparing && this.transferReadPending)) return;
    if (this.transferReductionCapacity !== context.buffers.count) {
      this.transferReduction?.dispose();
      this.transferReductionCapacity = context.buffers.count;
      this.transferReduction = new FluidReduction(context.buffers.count);
    }
    let keys = this.transferReductionKeys.get(context.buffers);
    if (!keys) { keys = [{}, {}, {}, {}]; this.transferReductionKeys.set(context.buffers, keys); }
    const tagMask = context.system.getGPUFilterTagMask(this.tags);
    this.transferReduction!.compute(renderer, keys[after ? 1 : 0], index => {
      const particle = context.buffers.storage.createParticle(index, true);
      const velocity = particle.velocity.mul(particle.speed);
      return vec4(velocity.lengthSq().mul(particle.mass.max(0)).mul(0.5), velocity);
    }, index => {
      const particle = context.buffers.storage.createParticle(index, true);
      return particle.alive.notEqual(0).and(tagMask === undefined ? uint(1).equal(1)
        : particle.tagMask.bitAnd(uint(tagMask)).notEqual(0));
    }, false);
    const key = after ? 'kineticEnergyAfterTransfer' : 'kineticEnergyBeforeTransfer';
    const read = preparing ? undefined : renderer.getArrayBufferAsync(this.transferReduction!.attribute)
      .then(buffer => {
      const values = new Float32Array(buffer);
      const count = values[8];
      this.benchmarks.set(key, values[4] * count);
      this.benchmarks.set('markerCount', count);
      this.benchmarks.set('picContribution', this.picRatio);
      this.benchmarks.set('flipContribution', 1 - this.picRatio);
      this.benchmarks.set(after ? 'meanVelocityAfterTransfer' : 'meanVelocityBeforeTransfer',
        Math.hypot(values[5], values[6], values[7]));
    });
    this.transferReduction!.compute(renderer, keys[after ? 3 : 2], index => {
      const particle = context.buffers.storage.createParticle(index, true);
      const velocity = particle.velocity.mul(particle.speed);
      return vec4(velocity.lengthSq(), velocity);
    }, index => {
      const particle = context.buffers.storage.createParticle(index, true);
      return particle.alive.notEqual(0).and(tagMask === undefined ? uint(1).equal(1)
        : particle.tagMask.bitAnd(uint(tagMask)).notEqual(0));
    }, false);
    const varianceRead = preparing ? undefined : renderer.getArrayBufferAsync(this.transferReduction!.attribute)
      .then(buffer => {
      const values = new Float32Array(buffer);
      const variance = Math.max(0, values[4] - values[5] ** 2 - values[6] ** 2 - values[7] ** 2);
      const name = after ? 'velocityVarianceAfterTransfer' : 'velocityVarianceBeforeTransfer';
      this.benchmarks.set(name, variance);
    });
    if (preparing) return;
    if (after) this.transferReadPending = true;
    void Promise.all([read, varianceRead]).catch(() => {}).finally(() => {
      if (after) this.transferReadPending = false;
    });
  }

  protected override onGridResolutionChanged(): void {
    this.workPool?.cancelPending(); this.workPool = undefined;
    this.clearNewPressureNode = undefined;
    this.movingWallsNode = undefined;
    this.movingWallsKey = '';
    this.workGrid?.dispose();
    this.workGrid = undefined;
    this.clearFieldsNode = undefined;
    this.resetFields = true;
    this.pressureProjection?.dispose();
    this.pressureProjection = undefined;
    this.velocityBeforeAttribute = undefined;
    this.velocityBefore = undefined;
    this.gatherNode = undefined;
    this.forceNodeCompute = undefined;
    this.transferNode = undefined;
    this.separationNode = undefined;
    this.separationApplyNode = undefined;
    this.gatherCacheKey = '';
    this.gatherBuffers = undefined;
    this.gatherGrid = undefined;
  }

  protected override computeCells(callback: (index: Node<'uint'>) => void): ComputeNode {
    return this.workGrid ? this.workGrid!.compute(callback) : super.computeCells(callback);
  }

  protected override diagnosticCellActive(index: Node<'uint'>): Node<'bool'> {
    return this.workGrid ? this.workGrid.active(index)
      : super.diagnosticCellActive(index);
  }

  protected override computeSolidCells(callback: (index: Node<'uint'>) => void): ComputeNode {
    return this.computeCells(callback);
  }

  protected override computeNewSolidCells(callback: (index: Node<'uint'>) => void): ComputeNode | undefined {
    return this.workGrid?.compute(callback, false, true);
  }

  protected override get cacheSolidOccupancy(): boolean { return true; }

  protected override onParticleColliderGeometryChanged(): void {
    this.movingWallsNode = undefined;
    this.separationApplyNode = undefined;
    this.boundaryCollisions.forEach((collision) => {
      collision.radiusOffset = this.particleCollisionThicknessValue;
      collision.needsUpdate = true;
    });
  }

  private computeMovingWalls(
    context: GPUParticleUpdateContext,
    renderer: ParticleSpatialGridRenderer,
    grid: ParticleSpatialGrid,
  ): void {
    const backend = this.particleCollisionBackend;
    if (!backend.hasGeometry || !backend.hasMotion) return;
    const tagMask = context.system.getGPUFilterTagMask(this.tags);
    const key = [context.buffers.version, backend.motionVersion, tagMask].join('|');
    if (key !== this.movingWallsKey || this.gatherBuffers !== context.buffers) this.movingWallsNode = undefined;
    this.movingWallsKey = key;
    this.movingWallsNode ??= Fn(() => {
      const particle = context.buffers.storage.createParticle(undefined, true);
      const selected = tagMask === undefined ? particle.alive.notEqual(0)
        : particle.alive.notEqual(0).and(particle.tagMask.bitAnd(uint(tagMask)).notEqual(0));
      If(selected.and(this.isInsideCap(particle.position)), () => {
        const radius = max(particle.scale.x.abs(), max(particle.scale.y.abs(), particle.scale.z.abs()))
          .mul(0.5).add(this.particleCollisionThickness);
        const position = transformPointGPU(particle.position, context.simulationToWorldNode);
        const hit = backend.queryMovingCapsule(position, position, radius);
        const displacement = hit.get('wallDisplacement') as Node<'vec3'>;
        If((hit.get('found') as Node<'bool'>).and(displacement.lengthSq().greaterThan(1e-12)), () => {
          particle.position.assign(transformPointGPU(hit.get('capsulePoint') as Node<'vec3'>,
            context.worldToSimulationNode));
          const normal = context.worldToSimulationNode.mul(vec4(hit.get('normal') as Node<'vec3'>, 0))
            .xyz.normalize();
          const wallVelocity = context.worldToSimulationNode.mul(vec4(displacement, 0)).xyz
            .div(context.deltaTimeNode.max(1e-6));
          const approach = particle.velocity.mul(particle.speed).sub(wallVelocity).dot(normal).min(0);
          If(particle.speed.abs().greaterThan(1e-6), () => {
            particle.velocity.assign(this.clampVelocity(particle.velocity.sub(normal.mul(approach)
              .div(particle.speed))));
          });
          context.buffers.storage.storeParticle(particle);
        });
      });
    })().compute(context.buffers.count);
    this.movingWallsNode.count = context.buffers.count;
    renderer.compute(this.movingWallsNode);
    // P2G and separation must query the corrected positions, not the old hash.
    this.benchmarks.span('particleSpatialIndex', () => grid.rebuild(renderer, context.buffers, {}));
  }

  private getPressureProjection(): FluidPressureProjection {
    this.pressureProjection ??= new FluidPressureProjection(
      this.gridDimensions, this.cellSizeNode, this.maxVelocityNode, this.solid, this.pressureCurrent, this.divergence,
      this.closedMinNode, this.closedMaxNode, this.workGrid, this.velocityNext, index => this.targetDivergence(index),
      undefined, this.faceOpenness, this.solidVelocity, () => this.pressureControls, this.pressureScratchSource,
    );
    this.pressureScratchSource = undefined;
    return this.pressureProjection;
  }

  protected override solveProjection(
    renderer: ParticleSpatialGridRenderer,
    input: { element(index: Node | number): Node<'vec4'> },
    output: { element(index: Node | number): Node<'vec4'> },
  ): void {
    this.getPressureProjection();
    this.pressureProjection!.captureBefore(renderer, this.velocityBefore!);
    this.benchmarks.span('pressureSolve', () => {
      this.pressureProjection!.solve(renderer, input, output, this.pressureIterations);
    });
  }

  protected override targetDivergence(index: Node<'uint'>): Node<'float'> {
    // Relax excess marker density without creating a tensile force at free surfaces.
    return this.velocityBefore!.element(index).w.sub(1).clamp(0, 1).mul(3);
  }

  public override cleanup(): void {
    this.cancelQualityPreparation(); this.liveContext = undefined;
    this.transferReduction?.dispose();
    this.transferReduction = undefined;
    this.transferReductionCapacity = 0;
    this.separationAttribute?.dispose();
    this.separationAttribute = undefined;
    this.separationPositions = undefined;
    this.onGridResolutionChanged();
    super.cleanup();
  }

  private gridToParticleGPU(particle: GPUParticleLike, context: GPUParticleUpdateContext): void {
    const beforeSample = this.sampleTransferField(particle.position, this.velocityBefore!);
    const inside = particle.position.greaterThanEqual(this.boundsMinNode).all()
      .and(particle.position.lessThan(this.boundsMinNode.add(this.cellSizeNode.mul(this.dimensionsNode))).all())
      .and(beforeSample.w.greaterThan(1e-6));
    const coordinate = particle.position.sub(this.boundsMinNode).div(this.cellSizeNode);
    const picVelocity = this.pressureProjection!.sample(coordinate);
    const before = this.pressureProjection!.sample(coordinate, true);
    const flipVelocity = vec3(particle.velocity).add(picVelocity.sub(before));
    const velocity = this.clampVelocity(mix(flipVelocity, picVelocity, this.picRatioNode));
    const gravityModifier = this.evaluateDynamicGPU.number(
      'gravityModifier.flip', () => context.system.gravityModifier,
      particle.time, 0, particle.index,
    );
    const gravityStep = context.gravityNode.mul(context.deltaTimeNode.mul(gravityModifier));
    // The system integrator adds gravity immediately before moving particles.
    If(inside, () => {
      particle.velocity.assign(velocity.sub(gravityStep));
      if (this.advectParticlesEnabled) particle.position.addAssign(velocity.mul(context.deltaTimeNode));
    });
  }

  private sampleTransferField(
    position: Node<'vec3'>,
    field: { element(index: Node | number): Node<'vec4'> },
  ): Node<'vec4'> {
    const gridPosition = vec3(position.sub(this.boundsMinNode).div(this.cellSizeNode).sub(0.5));
    const base = floor(gridPosition);
    const ratio = clamp(gridPosition.sub(base), vec3(0), vec3(1));
    const result = vec4(0).toVar();
    // Retain x-fastest donor order and interpolation while avoiding a large unrolled TSL graph.
    Loop(8, ({ i }) => {
      const delta = ivec3(i.mod(2), i.div(2).mod(2), i.div(4));
      const index = this.cellIndex(ivec3(clamp(
        base.add(vec3(delta)), vec3(0), this.dimensionsNode.sub(1),
      )));
      // FLIP deltas require identical donors before and after projection.
      // Density in the before field is not an interpolation weight.
      const valid = this.velocityBefore!.element(index).w.greaterThan(0)
        .and(this.velocityCurrent.element(index).w.greaterThan(0));
      const weights = vec3(delta.x.equal(0).select(float(1).sub(ratio.x), ratio.x),
        delta.y.equal(0).select(float(1).sub(ratio.y), ratio.y),
        delta.z.equal(0).select(float(1).sub(ratio.z), ratio.z));
      const weight = weights.x.mul(weights.y).mul(weights.z);
      result.addAssign(valid.select(vec4(field.element(index).xyz, 1).mul(weight), vec4(0)));
    });
    return result;
  }


}

function transformPointGPU(point: Node<'vec3'>, matrix: Node<'mat4'>): Node<'vec3'> {
  return matrix.mul(vec4(point, 1)).xyz as Node<'vec3'>;
}

export default FLIPSimulation;
