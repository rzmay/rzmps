import FluidColliderAtlas from '../spatial/effects/gpu/FluidColliderAtlas';
import FluidColliderField from '../spatial/effects/gpu/FluidColliderField';
import type { WebGPURenderer } from 'three/webgpu';
import prepareComputePrograms from '../utils/gpu/prepareComputePrograms';
import { BenchmarkMetricType } from '../enums/BenchmarkMetricType';
import { GeometryUpdatePolicy } from '../enums/GeometryUpdatePolicy';
import type { SpatialGridDomain } from '../spatial/structures/spatialGridDomain.utils';
import * as THREE from 'three';
import Benchmarks from '../core/Benchmarks';
import FluidGridHelper from '../simulation/gpu/FluidGridHelper';
import type SparseVolumeGrid from '../spatial/structures/gpu/SparseVolumeGrid';
import { StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import {
  Fn, If, Loop, clamp, float, floor, instanceIndex, int, ivec3, max, min, mix, storage, uint, uniform, vec3, vec4,
} from 'three/tsl';
import { bindStorageAttributeLifetime, initializeStorageAttribute } from '../utils/gpu/storage.utils';
import FluidReduction from '../simulation/gpu/FluidReduction';
import FluidGuardPrediction, {
  type FluidGuardFace, type FluidGuardSource,
} from '../simulation/gpu/FluidGuardPrediction';
import Module, { type ModuleExecutionContext, type ModuleOptions } from '../core/Module';
import type ParticleSystem from '../core/ParticleSystem';
import type { GPUParticleBufferState, GPUParticleLike, GPUParticleUpdateContext } from '../simulation/gpu/Particle';
import ParticleSpatialGrid, {
  type ParticleSpatialGridOptions,
  type ParticleSpatialGridRenderer,
} from '../spatial/structures/ParticleSpatialGrid';
import FluidCollider from '../spatial/effects/FluidCollider';
import ThreeGPUCollisionBackend, {
  type ThreeGPUCollisionBackendOptions,
} from '../collision/ThreeGPUCollisionBackend';
import { isIgnoredCollisionObject } from '../collision/isIgnoredCollisionObject';
import { boundsVector, createSpatialDomain } from '../spatial/structures/spatialGridDomain.utils';
import getAttributeVersion from '../utils/getAttributeVersion';
import type { ThreeCollisionBackendOptions } from '../collision/ThreeCollisionBackend';
import type { FluidPressureDiagnostics, FluidPressureControls } from '../simulation/gpu/FluidPressureProjection';
import { FluidBoundsPolicy } from '../enums/FluidBoundsPolicy';

type Vec4Storage = { element(index: Node | number): Node<'vec4'> };
type FloatStorage = { element(index: Node | number): Node<'float'> };
type UniformNode<T, TNode extends string> = Node<TNode> & { value: T };

/** Mesh discovery uses the same roots and filters as Three's collision backends. */
export type FluidCollisionOptions = Pick<ThreeGPUCollisionBackendOptions,
  'world' | 'staticObjects' | 'dynamicObjects' | 'geometryDynamicObjects' | 'objectFilter'
  | 'staticObjectFilter' | 'dynamicObjectFilter' | 'geometryDynamicObjectFilter' | 'updatePolicy'
> & Pick<ThreeCollisionBackendOptions, 'staticAfter'> & {
  /** Additional contact shell in mesh-local units. Defaults to zero. */
  surfaceThickness?: number;
  /** Resolution of collected meshes' cached occupancy fields. Defaults to 16. */
  bakedFieldResolution?: number;
};

export interface FluidSimulationOptions extends Partial<ModuleOptions> {
  /** Opt-in mesh collection; omitted world uses the owning scene. Explicit lists suppress scene discovery. */
  collisionOptions?: FluidCollisionOptions;
  bounds: THREE.Box3;
  spatialGridOptions: Partial<ParticleSpatialGridOptions>;
  /** Maximum pressure work: iterative sweeps or estimated fine-cell-equivalent multigrid work. */
  pressureIterations: number;
  /** Requests CFL-limited system steps; other modules share the resulting step. Defaults to true. */
  adaptiveTimestep?: boolean;
  /** Maximum travel per cell per step. Defaults to 2. */
  cfl?: number;
  /** Maximum additional fluid steps per incoming interval. Defaults to 4. */
  maxFluidSubsteps?: number;
  /** Minimum pressure-work budget. Omission follows pressureIterations for a fixed solve. */
  pressureMinIterations?: number;
  /** Maximum pressure-work budget. Omission follows pressureIterations. */
  pressureMaxIterations?: number;
  /** Maximum absolute Poisson residual; zero disables convergence checks. */
  pressureTolerance?: number;
  /** Collect asynchronous pressure and divergence diagnostics through benchmarks. Defaults to false. */
  pressureDiagnostics?: boolean;
  /** Preserve pressure between compatible solves. Defaults to true. */
  pressureWarmStart?: boolean;
  externalForce: THREE.Vector3;
  maxVelocity: number;
  /** Behavior at the finite spatialGridOptions.maxBounds cap, not intermediate adaptive edges. Defaults to Ballistic.
   * Quality limits do not act as physical caps. */
  boundsPolicy: FluidBoundsPolicy;
  /** Fluid-owned growth applied between updates. GPU hash auto-expansion is disabled. */
  automaticPadding: boolean;
  showGridHelper: boolean;
  /** Kept for older presets. The spatial grid depth takes precedence when supplied. */
  resolution: number;
}

abstract class FluidSimulation extends Module {
  collisionOptions?: FluidCollisionOptions;
  private readonly collectedColliders = new Map<THREE.Mesh, {
    collider: FluidCollider; revision: string; lastMovedAt: number;
  }>();
  private collisionElapsed = 0;
  bounds: THREE.Box3;
  readonly particleBounds = new THREE.Box3();
  /** Last accepted particle/source plus persistent-field support. */
  readonly occupiedBounds = new THREE.Box3();
  readonly gridDimensions = new THREE.Vector3();
  protected readonly dimensionsNode = uniform(new THREE.Vector3());
  protected previousDomain?: { bounds: THREE.Box3; dimensions: THREE.Vector3; cellSize: number };
  resolution: number;
  cellSize: number;
  pressureIterations: number;
  adaptiveTimestep: boolean;
  cfl: number;
  maxFluidSubsteps: number;
  pressureMinIterations?: number;
  pressureMaxIterations?: number;
  pressureTolerance: number;
  pressureDiagnostics: boolean;
  pressureWarmStart: boolean;
  /** Last completed GPU diagnostic sample; null until explicitly collected. */
  readonly pressureStats: FluidPressureDiagnostics = {
    pressureResidual: null,
    maxDivergenceBeforeProjection: null,
    meanDivergenceBeforeProjection: null,
    maxDivergenceAfterProjection: null,
    meanDivergenceAfterProjection: null,
    pressureIterations: null,
    maxVelocity: null,
    nonFiniteSamples: null,
  };
  externalForce: THREE.Vector3;
  maxVelocity: number;
  boundsPolicy: FluidBoundsPolicy;
  automaticPadding: boolean;
  showGridHelper: boolean;
  readonly autoBounds: boolean;

  protected cellCount: number;
  protected readonly boundsMinNode: UniformNode<THREE.Vector3, 'vec3'>;
  protected readonly cellSizeNode: UniformNode<number, 'float'>;
  protected readonly forceNode: UniformNode<THREE.Vector3, 'vec3'>;
  protected readonly maxVelocityNode: UniformNode<number, 'float'>;
  protected readonly closedMinNode = uniform(new THREE.Vector3()) as UniformNode<THREE.Vector3, 'vec3'>;
  protected readonly closedMaxNode = uniform(new THREE.Vector3()) as UniformNode<THREE.Vector3, 'vec3'>;
  private readonly capMinNode = uniform(new THREE.Vector3()) as UniformNode<THREE.Vector3, 'vec3'>;
  private readonly capMaxNode = uniform(new THREE.Vector3()) as UniformNode<THREE.Vector3, 'vec3'>;
  private readonly capEnabledNode = uniform(0) as UniformNode<number, 'float'>;
  private readonly boundsPolicyNode = uniform(0) as UniformNode<number, 'float'>;
  private readonly capOrigin = new THREE.Vector3();
  private boundsReconcileKey = '';
  private boundsReconcileNode?: ComputeNode;
  private boundsReconcileBuffers?: GPUParticleBufferState;
  private lastParticleBuffers?: GPUParticleBufferState;
  private fluidStateGeneration = 0;
  protected velocityCurrentAttribute!: StorageBufferAttribute;
  protected velocityNextAttribute!: StorageBufferAttribute;
  protected pressureCurrentAttribute!: StorageBufferAttribute;
  protected divergenceAttribute!: StorageBufferAttribute;
  protected solidAttribute!: StorageBufferAttribute;
  protected velocityCurrent!: Vec4Storage;
  protected velocityNext!: Vec4Storage;
  protected pressureCurrent!: FloatStorage;
  protected divergence!: FloatStorage;
  protected solid!: FloatStorage;
  protected boundaryAttribute!: StorageBufferAttribute;
  protected faceOpenness!: Vec4Storage;
  protected solidVelocity!: Vec4Storage;
  private readonly boundaryMotion = new Map<FluidCollider, {
    previous: THREE.Matrix4;
    transform: UniformNode<THREE.Matrix4, 'mat4'>;
  }>();
  private readonly boundaryDt = uniform(1) as UniformNode<number, 'float'>;
  private lastBoundsRead = 0;
  private guardPrediction?: FluidGuardPrediction;
  private guardContext?: GPUParticleUpdateContext;
  private readonly guardParticleKeys = new WeakMap<object, Map<string, object>>();
  /** @internal Observations only; these are not simulation tuning parameters. */
  readonly guardDiagnostics = { faces: [] as FluidGuardFace[], observedAt: 0, supportObservationAgeMs: 0 };
  private capacityObservation = { demand: 0, time: 0 };
  private boundsReadPending = false;
  protected boundsGeneration = 0;
  protected pendingBounds?: { grid: ParticleSpatialGrid; bounds: THREE.Box3 };
  private compactBoundsReadCount = 0;
  private readonly colliderAtlas = new FluidColliderAtlas();
  private solidNode?: ComputeNode;
  private solidFreshNode?: ComputeNode;
  private boundaryReduction?: FluidReduction;
  private boundaryReadPending = false;
  private readonly boundaryReductionKey = {};
  private solidCacheKey = '';
  protected pressureTopologyVersion = 0;
  private boundaryTopologyKey = '';
  private pressureBoundaryStateKey = '';
  private solidStateKey = '';
  private boundaryWasMoving = false;
  private _boundsHelper?: THREE.Group;
  private _particleBoundsHelper?: THREE.Box3Helper;
  private _gridBoundsHelper?: THREE.Box3Helper;
  private _brickHelper?: FluidGridHelper;
  /** Internal debug-grid access, not part of the public module contract. @internal */
  protected get visualizationGrid(): SparseVolumeGrid | undefined { return undefined; }
  private _boundsHelperSystem?: ParticleSystem;
  protected readonly particleCollisionBackend = new ThreeGPUCollisionBackend({ sweptMotion: true });
  private readonly particleCollisionThicknessNode = uniform(0) as UniformNode<number, 'float'>;
  protected particleCollisionThicknessValue = 0;
  private particleCollisionState = false;
  private particleCollisionCacheKey = '';
  protected usesParticleColliderSweeps = false;
  constructor(options: Partial<FluidSimulationOptions> = {}) {
    const gridOptions = options.spatialGridOptions ?? {};
    const requestedDepth = Math.max(1, Math.ceil(Math.log2(options.resolution ?? 32)));
    const brickSubdivisions = gridOptions.brickSubdivisions ?? 2;
    const cellSubdivisions = gridOptions.cellSubdivisions
      ?? Math.max(0, requestedDepth - brickSubdivisions);
    const resolution = 2 ** (brickSubdivisions + cellSubdivisions);
    const bounds = options.bounds?.clone() ?? new THREE.Box3(
      new THREE.Vector3(-1, -1, -1),
      new THREE.Vector3(1, 1, 1),
    );
    const automaticPadding = !options.bounds && (options.automaticPadding ?? false);
    const staticQuality = gridOptions.autoVolumeQuality === false
      || (gridOptions.volumeQuality !== undefined && gridOptions.autoVolumeQuality !== true);
    const quality = gridOptions.volumeQuality ?? gridOptions.minVolumeQuality ?? 2;
    const initialDomain = createSpatialDomain(bounds, resolution, 2 ** cellSubdivisions, {
      ...gridOptions, cubicBounds: false, centeredAtOrigin: false,
      ...(staticQuality ? { minVolumeQuality: quality, maxVolumeQuality: quality } : {}),
    });
    const spatialGrid = {
      ...gridOptions, bounds: options.bounds?.clone(), brickSubdivisions, cellSubdivisions,
      powerOfTwoBounds: true, cubicBounds: false, centeredAtOrigin: false, autoExpand: false,
      autoShrink: gridOptions.autoShrink ?? true, shrinkDelay: gridOptions.shrinkDelay ?? 600,
    };
    super(Module.CPU_UNSUPPORTED, {
      ...options,
      priority: options.priority ?? Module.Priority.Permanent,
      modifyGPU: () => {},
      requireSpatialEffects: options.requireSpatialEffects ?? FluidCollider,
      useSpatialGrid: true,
      spatialGridOptions: spatialGrid,
    });

    this.bounds = initialDomain.bounds.clone();
    this.gridDimensions.copy(initialDomain.gridDimensions);
    this.dimensionsNode.value.copy(this.gridDimensions);
    for (const [name, axis] of [['width', 'x'], ['height', 'y'], ['depth', 'z']] as const) {
      this.benchmarks.register(`grid/${name}`, { type: BenchmarkMetricType.Gauge, unit: 'count',
        get: () => this.gridDimensions[axis] });
    }
    this.benchmarks.register('grid/cellSize', { type: BenchmarkMetricType.Gauge, unit: 'units',
        get: () => this.cellSize });
    this.autoBounds = !options.bounds;
    this.collisionOptions = options.collisionOptions;
    this.resolution = resolution;
    this.cellCount = this.gridFieldCellCount;
    this.pressureIterations = Math.max(0, Math.floor(options.pressureIterations ?? 12));
    this.adaptiveTimestep = options.adaptiveTimestep ?? true;
    this.cfl = options.cfl ?? 2;
    this.maxFluidSubsteps = options.maxFluidSubsteps ?? 4;
    this.pressureMinIterations = options.pressureMinIterations;
    this.pressureMaxIterations = options.pressureMaxIterations;
    this.pressureTolerance = options.pressureTolerance ?? 0;
    this.pressureDiagnostics = options.pressureDiagnostics ?? false;
    this.pressureWarmStart = options.pressureWarmStart ?? true;
    for (const key of Object.keys(this.pressureStats)) this.benchmarks.register(key, {
      type: BenchmarkMetricType.Gauge, get: () => this.pressureStats[key as keyof FluidPressureDiagnostics],
    });
    this.externalForce = options.externalForce?.clone() ?? new THREE.Vector3(0, -9.81, 0);
    this.maxVelocity = Math.max(0, options.maxVelocity ?? 20);
    this.boundsPolicy = options.boundsPolicy ?? FluidBoundsPolicy.Ballistic;
    this.bounds.getCenter(this.capOrigin);
    this.automaticPadding = automaticPadding;
    this.showGridHelper = options.showGridHelper ?? false;
    this.cellSize = initialDomain.cellSize;
    this.boundsMinNode = uniform(this.bounds.min.clone()) as UniformNode<THREE.Vector3, 'vec3'>;
    this.cellSizeNode = uniform(this.cellSize) as UniformNode<number, 'float'>;
    this.forceNode = uniform(this.externalForce) as UniformNode<THREE.Vector3, 'vec3'>;
    this.maxVelocityNode = uniform(this.maxVelocity) as UniformNode<number, 'float'>;
    this.syncBoundsPolicy();
    this.allocateGridFields();
  }

  public override async prepareResources(system: ParticleSystem, renderer: ParticleSpatialGridRenderer): Promise<void> {
    this.storageRenderer = renderer;
    // Resource preparation deliberately bypasses per-step callbacks and transform history.
    this.synchronizeParticleStorage(system.gpuSimulation.prepareContext(
      renderer as import('three/webgpu').WebGPURenderer), renderer);
    this.prepareSpatialEffects(system);
    this.collectColliders(system);
    // BVH setup can establish an index on previously unindexed source geometry. Do it before
    // acquiring bakes so compilation cannot replace an already-baked geometry revision.
    if (!this.particleCollisionBackend.hasGeometry) {
      this.updateParticleCollisionBackend(system, 0);
      // Packing unindexed meshes can establish their source index. Capture the finalized
      // geometry revision before acquiring occupancy graphs keyed by the wrapper revision.
      this.collectColliders(system);
    }
    for (const collider of this.fluidColliders) {
      collider.syncGPUTransform(system);
      collider.prepareGPUField(renderer);
    }
    for (const attribute of [this.velocityCurrentAttribute, this.velocityNextAttribute,
      this.pressureCurrentAttribute, this.divergenceAttribute,
      this.solidAttribute, this.boundaryAttribute]) initializeStorageAttribute(renderer, attribute);
    // Compile the real baked boundary representation without submitting occupancy or advancing motion.
    const compiler = renderer as ParticleSpatialGridRenderer & {
      compileComputeAsync?: (nodes: ComputeNode[]) => Promise<void>;
    };
    const prepared = this.fluidColliders.every(collider => collider.hasPreparedGPUField && !collider.conditionGPU);
    if (compiler.compileComputeAsync && prepared) {
      const nodes: ComputeNode[] = [];
      const compute = renderer.compute;
      const previousMoving = this.boundaryWasMoving;
      const previousDt = this.boundaryDt.value;
      const motionState = new Map([...this.boundaryMotion].map(([collider, motion]) => [collider, {
        previous: motion.previous.clone(), transform: motion.transform.value.clone(),
      }]));
      renderer.compute = node => { nodes.push(...(Array.isArray(node) ? node : [node])); };
      try {
        const context = { system, deltaTimeNode: uniform(1 / 60) } as unknown as GPUParticleUpdateContext;
        this.computeSolidField(context, renderer);
        this.appendBoundaryPrograms(nodes);
      } finally {
        renderer.compute = compute;
        this.solidStateKey = '';
        this.boundaryWasMoving = previousMoving;
        this.boundaryDt.value = previousDt;
        motionState.forEach((state, collider) => {
          const motion = this.boundaryMotion.get(collider);
          motion?.previous.copy(state.previous);
          motion?.transform.value.copy(state.transform);
        });
      }
      await this.benchmarks.spanAsync('boundaryPipelineCompilation',
        () => prepareComputePrograms(compiler, [...new Set(nodes)], () => true, this.benchmarks));
    }

  }

  public override getSimulationSubstepLimit(): number {
    if (!Number.isSafeInteger(this.maxFluidSubsteps) || this.maxFluidSubsteps < 1) {
      throw new RangeError('maxFluidSubsteps must be a positive integer.');
    }
    return this.maxFluidSubsteps;
  }

  public override getSimulationTimestep(requestedDt: number): number {
    if (!this.adaptiveTimestep) return Infinity;
    if (!Number.isFinite(this.cfl) || this.cfl <= 0
      || !Number.isSafeInteger(this.maxFluidSubsteps) || this.maxFluidSubsteps < 1) {
      throw new RangeError('Fluid CFL must be positive and maxFluidSubsteps a positive integer.');
    }
    // Until a measured field speed is available, the existing velocity safety
    // ceiling is conservative. Async observations never stall the render thread.
    const speed = Math.max(this.pressureStats.maxVelocity ?? this.maxVelocity, 1e-6);
    const safeDt = this.cfl * this.cellSize / speed;
    const count = Math.min(this.maxFluidSubsteps, Math.max(1, Math.ceil(requestedDt / safeDt)));
    this.benchmarks.set('fluidSubsteps', count);
    this.benchmarks.set('requestedDt', requestedDt);
    this.benchmarks.set('effectiveSolverDt', Math.min(requestedDt, safeDt));
    return Math.min(requestedDt, safeDt);
  }

  public override prepare(context: ModuleExecutionContext): void {
    const { system: particleSystem, deltaTime: dt } = context;
    if (!particleSystem.isGPUProcessingActive) {
      throw new Error('Fluid simulations require GPU particle processing with a WebGPU renderer.');
    }
    super.prepare(context);
    this.collisionElapsed += Math.max(0, dt);
    this.collectColliders(particleSystem);
    const grid = this.getParticleSpatialGrid(particleSystem);
    if (grid) this.synchronizeGridBounds(grid, particleSystem.sceneRenderer as ParticleSpatialGridRenderer);
    this.syncBoundsPolicy();
    this.updateParticleCollisionBackend(particleSystem, dt);
    this.updateBoundsHelper(particleSystem);
    this.forceNode.value.copy(this.externalForce);
    this.maxVelocityNode.value = this.maxVelocity;
  }

  private syncBoundsPolicy(): void {
    const index = Object.values(FluidBoundsPolicy).indexOf(this.boundsPolicy as FluidBoundsPolicy);
    if (index < 0) throw new RangeError('Unknown fluid boundsPolicy.');
    this.boundsPolicyNode.value = index;
    const size = this.bounds.getSize(new THREE.Vector3()), limit = this.boundsLimit;
    let capped = false;
    for (const axis of ['x', 'y', 'z'] as const) {
      const cap = !this.autoBounds || (Number.isFinite(limit[axis])
        && size[axis] >= Math.floor(limit[axis] / Math.max(this.spatialGrid?.brickSize ?? 1e-6, 1e-6))
          * (this.spatialGrid?.brickSize ?? 1e-6) - 1e-6);
      capped ||= cap;
      this.capMinNode.value[axis] = cap ? this.bounds.min[axis] : -3e38;
      this.capMaxNode.value[axis] = cap ? this.bounds.max[axis] : 3e38;
      const closed = cap && this.boundsPolicy === FluidBoundsPolicy.Contain;
      this.closedMinNode.value[axis] = closed ? 1 : 0;
      this.closedMaxNode.value[axis] = closed ? 1 : 0;
    }
    this.capEnabledNode.value = capped ? 1 : 0;
  }

  protected isInsideCap(position: Node<'vec3'>): Node<'bool'> {
    return this.capEnabledNode.lessThan(0.5).or(position.greaterThanEqual(this.capMinNode).all()
      .and(position.lessThan(this.capMaxNode).all()));
  }

  public override finalizeGPU(particle: GPUParticleLike): void {
    If(this.capEnabledNode.greaterThan(0.5), () => {
      If(this.boundsPolicyNode.equal(1).and(this.isInsideCap(particle.position).not()), () => {
        particle.alive.assign(uint(0));
      });
      If(this.boundsPolicyNode.equal(2), () => {
        const extent = this.capMaxNode.sub(this.capMinNode).mul(0.5);
        const half = min(extent.x, min(extent.y, extent.z));
        const epsilon = min(float(1e-5), half.mul(0.001));
        const radius = min(max(particle.scale.x.abs(), max(particle.scale.y.abs(), particle.scale.z.abs()))
          .mul(0.5), max(half.sub(epsilon), float(0)));
        const lower = this.capMinNode.add(radius).add(epsilon);
        const upper = this.capMaxNode.sub(radius).sub(epsilon);
        for (const axis of ['x', 'y', 'z'] as const) {
          const travel = particle.velocity[axis].mul(particle.speed);
          const outward = particle.position[axis].lessThan(lower[axis]).and(travel.lessThan(0))
            .or(particle.position[axis].greaterThan(upper[axis]).and(travel.greaterThan(0)));
          particle.velocity[axis].assign(outward.select(float(0), particle.velocity[axis]));
        }
        particle.position.assign(clamp(particle.position, lower, upper));
      });
    });
  }

  /** Reset lifecycle state before preparing replacement particle-buffer bindings. */
  private synchronizeParticleStorage(context: GPUParticleUpdateContext, renderer: ParticleSpatialGridRenderer): void {
    if (this.lastParticleBuffers && this.lastParticleBuffers !== context.buffers) {
      this.boundaryMotion.clear();
      this.boundaryWasMoving = false;
      this.boundsGeneration++;
      this.pendingBounds = undefined;
      this.boundsReadPending = false;
      this.lastBoundsRead = 0;
      this.guardDiagnostics.faces = []; this.guardDiagnostics.observedAt = 0;
      this.capacityObservation = { demand: 0, time: 0 };
      this.onParticleStateReset(renderer);
      this.resetGridNodes();
      for (const key of Object.keys(this.pressureStats)) {
        this.pressureStats[key as keyof FluidPressureDiagnostics] = null;
      }
    }
    this.lastParticleBuffers = context.buffers;
    this.guardContext = context;
  }

  public override computeGPU(
    context: GPUParticleUpdateContext,
    renderer: ParticleSpatialGridRenderer,
    grid?: ParticleSpatialGrid,
  ): void {
    this.storageRenderer = renderer;
    this.synchronizeParticleStorage(context, renderer);
    if (!grid || this.boundsPolicy === FluidBoundsPolicy.Ballistic
      || (this.autoBounds && this.boundsLimit.toArray().every(value => !Number.isFinite(value)))) return;
    const tagMask = context.system.getGPUFilterTagMask(this.tags);
    const key = [context.buffers.version, context.eventWriter?.version, context.eventWriter?.capacity,
      context.buffers.count, this.version, tagMask].join('|');
    if (key !== this.boundsReconcileKey || this.boundsReconcileBuffers !== context.buffers) {
      this.boundsReconcileKey = key;
      this.boundsReconcileBuffers = context.buffers;
      this.boundsReconcileNode = Fn(() => {
        const particle = context.buffers.storage.createParticle(undefined, true);
        const selected = particle.alive.notEqual(uint(0)).and(tagMask === undefined
          ? uint(1).equal(1) : particle.tagMask.bitAnd(uint(tagMask)).notEqual(uint(0)));
        If(selected, () => {
          const reconcile = () => {
            this.finalizeGPU(particle);
            If(particle.alive.equal(uint(0)), () => { context.eventWriter?.emitDeath(particle); });
            context.buffers.storage.storeParticle(particle);
          };
          if (this.conditionGPU) If(this.conditionGPU(particle, context.deltaTimeNode,
            { ...context, module: this, events: this.gpuExecutionContext.events,
              spatialGrid: grid, spatialEffects: this.spatialEffects }), reconcile);
          else reconcile();
        });
      })().compute(context.buffers.count);
    }
    renderer.compute(this.boundsReconcileNode!);
    grid.rebuild(renderer, context.buffers, {});
  }

  public override getParticleSpatialGrid(system: ParticleSystem): ParticleSpatialGrid | undefined {
    const existing = this.spatialGrid;
    const grid = super.getParticleSpatialGrid(system);
    // Seed automatic grids from the solver layout without making them explicitly fixed domains.
    if (!existing && grid && this.autoBounds) grid.setBounds(this.bounds);
    return grid;
  }

  /** A new particle storage identity denotes clear/reset, unlike an in-place capacity increase. */
  protected onParticleStateReset(_renderer: ParticleSpatialGridRenderer): void { void _renderer; }

  protected cellIndex(coordinate: Node<'ivec3'>): Node<'uint'> {
    return uint(coordinate.x.add(coordinate.y.mul(this.gridDimensions.x))
      .add(coordinate.z.mul(this.gridDimensions.x * this.gridDimensions.y)));
  }

  protected computeCells(callback: (index: Node<'uint'>) => void): ComputeNode {
    return Fn(() => callback(instanceIndex))().compute(this.cellCount);
  }

  /** Isolated resource/graph builder: immutable uniforms/config are inherited, storage and caches are local. */
  protected forkGridResources(count: number): this {
    const target = Object.create(this) as this;
    target.cellCount = count;
    Object.defineProperty(target, 'fieldStrideNode', { value: uniform(count, 'uint') });
    target.allocateGridFields();
    Object.defineProperty(target, 'benchmarks', { value: new Benchmarks() });
    Object.defineProperty(target, 'boundaryMotion', { value: new Map([...this.boundaryMotion].map(([collider, m]) => [
      collider, { previous: m.previous.clone(), transform: uniform(m.transform.value.clone()) },
    ])) });
    target.solidNode = undefined;
    target.solidFreshNode = undefined;
    target.solidCacheKey = '';
    target.solidStateKey = '';
    target.boundaryReduction = undefined;
    return target;
  }

  protected adoptGridResources(target: FluidSimulation): void {
    for (const key of ['velocityCurrentAttribute', 'velocityNextAttribute', 'pressureCurrentAttribute',
      'divergenceAttribute', 'solidAttribute', 'boundaryAttribute',
      'velocityCurrent', 'velocityNext', 'pressureCurrent', 'divergence', 'solid',
      'faceOpenness', 'solidVelocity', 'cellCount', 'solidNode', 'solidFreshNode', 'solidCacheKey'] as const) {
      (this as unknown as Record<string, unknown>)[key] = target[key];
    }
    this.fieldStrideNode.value = this.cellCount;
    // New shaders capture the replacement motion uniforms, but must inherit the latest live history.
    for (const [collider, motion] of target.boundaryMotion) {
      const current = this.boundaryMotion.get(collider);
      if (current) motion.previous.copy(current.previous);
    }
    this.boundaryMotion.clear();
    target.boundaryMotion.forEach((motion, collider) => this.boundaryMotion.set(collider, motion));
    this.solidStateKey = '';
    this.fluidStateGeneration++;
    this.boundsGeneration++;
    this.boundsReadPending = false;
  }

  protected resizeGridFields(count: number, dispose = true): void {
    if (dispose) this.disposeGridFields();
    this.cellCount = count;
    this.allocateGridFields();
    this.resetGridNodes();
  }

  protected cellCoordinate(index: Node<'uint'>): Node<'ivec3'> {
    return ivec3(
      int(index.mod(this.gridDimensions.x)),
      int(index.div(this.gridDimensions.x).mod(this.gridDimensions.y)),
      int(index.div(this.gridDimensions.x * this.gridDimensions.y)),
    );
  }

  protected cellCenter(coordinate: Node<'ivec3'>): Node<'vec3'> {
    return vec3(coordinate).add(0.5).mul(this.cellSizeNode).add(this.boundsMinNode);
  }

  protected worldToCell(position: Node<'vec3'>): Node<'ivec3'> {
    return ivec3(clamp(
      floor(position.sub(this.boundsMinNode).div(this.cellSizeNode)),
      vec3(0),
      this.dimensionsNode.sub(1),
    ));
  }

  protected sampleVelocity(position: Node<'vec3'>, field: Vec4Storage = this.velocityCurrent): Node<'vec3'> {
    return this.sampleField(position, field).xyz as Node<'vec3'>;
  }

  protected sampleField(
    position: Node<'vec3'>,
    field: Vec4Storage,
    occupancyOnly = false,
  ): Node<'vec4'> {
    const gridPosition = vec3(position.sub(this.boundsMinNode).div(this.cellSizeNode).sub(0.5));
    const base = floor(gridPosition);
    const ratio = clamp(gridPosition.sub(base), vec3(0), vec3(1));
    const sample = (x: number, y: number, z: number) => {
      const value = field.element(this.cellIndex(ivec3(clamp(
        base.add(vec3(x, y, z)), vec3(0), this.dimensionsNode.sub(1),
      ))));
      return occupancyOnly ? vec4(value.xyz, value.w.greaterThan(0).select(1, 0)) : value;
    };
    const lower = mix(
      mix(sample(0, 0, 0), sample(1, 0, 0), ratio.x),
      mix(sample(0, 1, 0), sample(1, 1, 0), ratio.x),
      ratio.y,
    );
    const upper = mix(
      mix(sample(0, 0, 1), sample(1, 0, 1), ratio.x),
      mix(sample(0, 1, 1), sample(1, 1, 1), ratio.x),
      ratio.y,
    );
    return mix(lower, upper, ratio.z) as Node<'vec4'>;
  }

  protected clampVelocity(velocity: Node<'vec3'>): Node<'vec3'> {
    const magnitude = max(velocity.length(), float(1e-6));
    return velocity.mul(clamp(this.maxVelocityNode.div(magnitude), 0, 1)) as Node<'vec3'>;
  }

  protected get hasParticleColliderGeometry(): boolean {
    return this.particleCollisionBackend.hasGeometry;
  }

  protected get particleCollisionThickness(): Node<'float'> {
    return this.particleCollisionThicknessNode;
  }

  protected queryParticleCollider(
    start: Node<'vec3'>,
    end: Node<'vec3'>,
    radius: Node<'float'>,
  ): Node {
    return this.particleCollisionBackend.queryCapsule(start, end, radius);
  }

  protected onParticleColliderGeometryChanged(): void {}

  protected ensureGridResolution(
    renderer: ParticleSpatialGridRenderer,
    grid: ParticleSpatialGrid,
  ): void {
    if (grid.cellsPerAxis === this.resolution && grid.gridDimensions.equals(this.gridDimensions)) return;
    this.disposeGridFields();
    this.resolution = grid.cellsPerAxis;
    this.gridDimensions.copy(grid.gridDimensions);
    this.dimensionsNode.value.copy(this.gridDimensions);
    this.cellCount = this.gridFieldCellCount;
    this.cellSize = grid.cellSize;
    this.cellSizeNode.value = this.cellSize;
    this.allocateGridFields();
    this.resetGridNodes();
    this.onGridResolutionChanged(renderer);
  }

  protected onGridResolutionChanged(renderer: ParticleSpatialGridRenderer): void {
    void renderer;
  }

  /** Sparse solvers replace the initial placeholder with their resident pool after super(). */
  protected get gridFieldCellCount(): number {
    return this.gridDimensions.x * this.gridDimensions.y * this.gridDimensions.z;
  }

  protected readonly fieldStrideNode = uniform(1, 'uint');

  private allocateGridFields(): void {
    this.fieldStrideNode.value = this.cellCount;
    this.velocityCurrentAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.velocityNextAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.pressureCurrentAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount), 1);
    this.divergenceAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount), 1);
    this.solidAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount), 1);
    this.velocityCurrent = storage(this.velocityCurrentAttribute, 'vec4', this.cellCount) as Vec4Storage;
    this.velocityNext = storage(this.velocityNextAttribute, 'vec4', this.cellCount) as Vec4Storage;
    this.pressureCurrent = storage(this.pressureCurrentAttribute, 'float', this.cellCount) as FloatStorage;
    this.divergence = storage(this.divergenceAttribute, 'float', this.cellCount) as FloatStorage;
    this.boundaryAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount * 8), 4);
    const boundary = storage(this.boundaryAttribute, 'vec4', this.cellCount * 2);
    const stride = this.fieldStrideNode;
    this.faceOpenness = boundary;
    this.solidVelocity = { element: index => boundary.element(
      uint(index as Node<'uint'>).add(stride),
    ) };
    this.solid = storage(this.solidAttribute, 'float', this.cellCount) as FloatStorage;
  }

  protected resetGridNodes(): void {
    this.fluidStateGeneration++;
    this.boundaryReduction?.dispose();
    this.boundaryReduction = undefined;
    this.solidNode = undefined;
    this.solidFreshNode = undefined;
    this.solidCacheKey = '';
    this.solidStateKey = '';
  }

  /** Boundary topology changes invalidate solver warm starts independently of transforms. */
  protected onBoundaryChanged(): void {}

  protected get cacheSolidOccupancy(): boolean { return false; }

  /** Include both full and newly-resident boundary variants in resource preparation. */
  protected appendBoundaryPrograms(nodes: ComputeNode[]): void {
    if (this.solidNode) nodes.push(this.solidNode);
    if (this.solidFreshNode) nodes.push(this.solidFreshNode);
  }

  protected computeSolidCells(callback: (index: Node<'uint'>) => void): ComputeNode {
    return this.computeCells(callback);
  }

  protected computeNewSolidCells(_callback: (index: Node<'uint'>) => void): ComputeNode | undefined {
    void _callback;
    return undefined;
  }

  protected storageRenderer?: ParticleSpatialGridRenderer;

  private disposeGridFields(): void {
    [
      this.velocityCurrentAttribute,
      this.velocityNextAttribute,
      this.pressureCurrentAttribute,
      this.divergenceAttribute,
      this.solidAttribute,
      this.boundaryAttribute,
    ].forEach(attribute => {
      if (!attribute) return;
      if (this.storageRenderer) bindStorageAttributeLifetime(this.storageRenderer, attribute);
      attribute.dispose();
    });
  }

  /** Prepare occupancy bindings independently of motion tracking, cache invalidation and quadrature. */
  private prepareColliderQueries(
    context: GPUParticleUpdateContext,
    renderer: ParticleSpatialGridRenderer,
    colliders: FluidCollider[],
  ) {
    const fields = [...new Set(colliders.flatMap(collider => {
      const field = collider.getGPUField();
      return field ? [field] : [];
    }))];

    // Uniform power-of-two layouts use the compact path. Other layouts preserve individual sampling
    // because rounding near field boundaries can change conservative zero/nonzero occupancy decisions.
    const resolution = fields[0]?.resolution ?? 0;
    const uniformResolution = resolution > 0 && Number.isInteger(Math.log2(resolution))
      && fields.every(field => field.resolution === resolution);
    const canBatch = colliders.length > 8 && uniformResolution
      && colliders.every(collider => collider.getGPUField() && !collider.conditionGPU);
    this.colliderAtlas.update(fields, renderer as unknown as WebGPURenderer);

    const samplers = new Map(colliders.map(collider => {
      const field = collider.getGPUField();
      return [collider, field ? this.colliderAtlas.sampler(field) : undefined] as const;
    }));
    const test = (collider: FluidCollider, position: Node<'vec3'>) =>
      collider.testPositionGPU(position, context, samplers.get(collider));
    const batched = !!this.colliderAtlas.texture && canBatch;

    if (batched) {
      const simulationToWorld = context.system.getSimulationToWorldMatrix();
      this.colliderAtlas.updateQueries(colliders.map(collider => ({
        field: collider.getGPUField()!, inverted: collider.inverted,
        inverse: collider.matrixWorld.clone().invert(),
        motion: this.boundaryMotion.get(collider)!.transform.value,
      })), simulationToWorld);
    }

    const query = batched ? this.colliderAtlas.createQuery(this.boundaryDt) : undefined;
    const queryKey = `${this.colliderAtlas.texture?.uuid ?? ''}:${batched}:${this.colliderAtlas.queryVersion}:`;

    const cacheKey = queryKey + colliders
      .map(collider => [collider.uuid, collider.version, collider.geometry?.uuid,
        collider.bakedFieldResolution, collider.surfaceThickness, collider.inverted].join(':'))
      .join('|');

    return { query, test, cacheKey };
  }

  protected computeSolidField(
    context: GPUParticleUpdateContext,
    renderer: ParticleSpatialGridRenderer,
  ): void {
    const colliders = this.fluidColliders.filter((effect): effect is FluidCollider => (
      effect instanceof FluidCollider && effect.visible && effect.gridOccupancy
    ));
    const inverseSystem = context.system.getSimulationToWorldMatrix().clone().invert();
    this.boundaryDt.value = Math.max(Number((context.deltaTimeNode as UniformNode<number, 'float'>).value ?? 0), 1e-6);
    let moving = false;
    colliders.forEach(collider => {
      collider.syncGPUTransform(context.system);
      collider.prepareGPUField(renderer);
      const current = inverseSystem.clone().multiply(collider.matrixWorld);
      let motion = this.boundaryMotion.get(collider);
      if (!motion) {
        motion = { previous: current.clone(), transform: uniform(new THREE.Matrix4()) };
        this.boundaryMotion.set(collider, motion);
      }
      motion.transform.value.copy(motion.previous).multiply(current.clone().invert());
      moving ||= !motion.previous.equals(current);
      motion.previous.copy(current);
    });
    for (const collider of this.boundaryMotion.keys()) {
      if (!colliders.includes(collider)) this.boundaryMotion.delete(collider);
    }
    const { query, test, cacheKey } = this.prepareColliderQueries(context, renderer, colliders);

    if (cacheKey !== this.solidCacheKey) {
      this.solidCacheKey = cacheKey;
      this.solidNode = undefined;
      this.solidFreshNode = undefined;
      this.solidStateKey = '';
      // New field bindings need new graphs, but do not mean collider resources changed.
      if (cacheKey !== this.boundaryTopologyKey) {
        this.boundaryTopologyKey = cacheKey;
        this.onBoundaryChanged();
      }
    }

    const stateKey = this.cacheSolidOccupancy ? [
      this.bounds.min.toArray(), this.cellSize, this.gridDimensions.toArray(),
      this.boundsLimit.toArray(), this.boundsPolicy, this.capOrigin.toArray(),
      context.system.simulationSpace, inverseSystem.elements,
      ...colliders.map(collider => [
        collider.matrixWorld.elements, collider.surfaceThickness, collider.inverted,
        collider.geometry?.uuid, attributeVersion(collider.geometry?.getAttribute('position')),
        collider.geometry?.index?.version, collider.bakedFieldResolution,
      ].join(',')),
    ].join('|') : '';
    const cacheable = this.cacheSolidOccupancy && colliders.every(collider => collider.canCacheGridOccupancy);
    // One final rebuild clears wall velocities on the first stationary frame.
    if (cacheable && !moving && this.solidNode && stateKey === this.solidStateKey
      && !this.boundaryWasMoving) {
      if (this.solidFreshNode) renderer.compute(this.solidFreshNode);
      this.collectBoundaryDiagnostics(renderer);
      return;
    }
    this.boundaryWasMoving = moving;
    const pressureBoundaryKey = `${cacheKey}|${stateKey}`;
    if (!cacheable || pressureBoundaryKey !== this.pressureBoundaryStateKey) {
      this.pressureBoundaryStateKey = pressureBoundaryKey;
      this.pressureTopologyVersion++;
    }

    const bake = (index: Node<'uint'>) => {
      const center = this.cellCenter(this.cellCoordinate(index));
      const occupied = this.capEnabledNode.greaterThan(0.5).and(this.boundsPolicyNode.equal(2))
        .and(this.isInsideCap(center).not()).select(float(1), float(0)).toVar('fluidSolidCell');
      const centerWallVelocity = vec3(0).toVar();

      if (query) {
        const hit = query(center).toVar();
        occupied.assign(max(occupied, hit.w));
        centerWallVelocity.assign(hit.xyz);
      } else {
        colliders.forEach((collider) => {
          const hit = test(collider, center).toVar();
          occupied.assign(max(occupied, hit));
          const previous = this.boundaryMotion.get(collider)!.transform.mul(vec4(center, 1)).xyz;
          centerWallVelocity.assign(hit.greaterThan(0).select(
            center.sub(previous).div(this.boundaryDt), centerWallVelocity,
          ));
        });
      }
      // Conservatively retain every occupied sample so thin walls cannot disappear.
      this.solid.element(index).assign(occupied.greaterThan(0).select(1, 0));

      // Face quadrature represents flux apertures independently of particle containment.
      const openness: Node<'float'>[] = [];
      const wallVelocity: Node<'float'>[] = [];
      for (let axis = 0; axis < 3; axis++) {
        const open = float(0).toVar();
        const velocity = float(0).toVar();
        // Keep quadrature in the shader loop instead of cloning collider graphs per sample.
        Loop(4, ({ i }) => {
          const u = float(i.mod(2)).sub(0.5).mul(0.5);
          const v = float(i.div(2)).sub(0.5).mul(0.5);
          const offset = axis === 0 ? vec3(-0.5, u, v) : axis === 1 ? vec3(u, -0.5, v) : vec3(u, v, -0.5);
          const position = center.add(offset.mul(this.cellSizeNode));
          const blocked = float(0).toVar();
          const motion = float(0).toVar();
          if (query) {
            const hit = query(position).toVar();
            blocked.assign(hit.w.greaterThan(0).select(1, 0));
            motion.assign(hit[(['x', 'y', 'z'] as const)[axis]]);
          } else {
            colliders.forEach(collider => {
              const hit = test(collider, position).greaterThan(0);
              const previous = this.boundaryMotion.get(collider)!.transform.mul(vec4(position, 1)).xyz;
              const component = (['x', 'y', 'z'] as const)[axis];
              motion.assign(hit.select(position.sub(previous)[component].div(this.boundaryDt), motion));
              blocked.assign(hit.select(float(1), blocked));
            });
          }
          open.addAssign(float(1).sub(blocked).mul(0.25));
          velocity.addAssign(motion.mul(blocked).mul(0.25));
        });
        openness.push(open);
        // A solid voxel can close a face even when face quadrature itself is clear.
        // Preserve its rigid velocity for that conservative boundary fallback.
        wallVelocity.push(open.lessThan(1).select(velocity.div(float(1).sub(open).max(1e-6)),
          centerWallVelocity[(['x', 'y', 'z'] as const)[axis]]));
      }

      // Positive cell volume keeps partially covered cells in pressure/advection.
      const fluid = float(0).toVar();
      Loop(8, ({ i }) => {
        const x = float(i.mod(2)).sub(0.5).mul(0.5);
        const y = float(i.div(2).mod(2)).sub(0.5).mul(0.5);
        const z = float(i.div(4)).sub(0.5).mul(0.5);
        const point = center.add(vec3(x, y, z).mul(this.cellSizeNode));
        const blocked = float(0).toVar();
        if (query) {
          blocked.assign(query(point).w.greaterThan(0).select(1, 0));
        } else {
          colliders.forEach(collider => {
            blocked.assign(max(blocked, test(collider, point).greaterThan(0).select(1, 0)));
          });
        }
        fluid.addAssign(float(1).sub(blocked).mul(0.125));
      });
      const unresolved = occupied.greaterThan(0).and(fluid.greaterThan(0.999))
        .and(openness[0].greaterThan(0.999)).and(openness[1].greaterThan(0.999)).and(openness[2].greaterThan(0.999));
      this.faceOpenness.element(index).assign(unresolved.select(vec4(0),
        vec4(openness[0], openness[1], openness[2], fluid)));
      this.solidVelocity.element(index).assign(vec4(wallVelocity[0], wallVelocity[1], wallVelocity[2], 0));
    };
    const solidNode = this.solidNode ?? this.computeSolidCells(bake);
    this.solidFreshNode ??= this.computeNewSolidCells(bake);
    // Forked preparation owners are absent from live-scene reflection; keep their build attribution stable.
    solidNode.setName('rzmps.fluid.classifyBoundary');
    this.solidFreshNode?.setName('rzmps.fluid.classifyFreshBoundary');
    this.solidNode = solidNode;

    this.benchmarks.span('boundaryUpdate', () => renderer.compute(solidNode));
    this.solidStateKey = stateKey;
    this.collectBoundaryDiagnostics(renderer);
  }

  protected diagnosticCellActive(index: Node<'uint'>): Node<'bool'> {
    return index.lessThan(this.fieldStrideNode);
  }

  /** Optional GPU reduction; only aggregate counts cross back to the CPU. */
  public async readBoundaryDiagnostics(renderer: ParticleSpatialGridRenderer): Promise<{
    boundaryCells: number; partiallyOpenFaces: number; fullyBlockedFaces: number;
  }> {
    const grid = this.visualizationGrid;
    this.boundaryReduction ??= new FluidReduction(grid?.reductionCellCount || this.cellCount, grid ? {
      count: grid.activeCellCount, index: index => grid.compactCell(index),
    } : undefined);
    this.boundaryReduction.compute(renderer, this.boundaryReductionKey, index => {
      const face = this.faceOpenness.element(index);
      const partial = float(0).toVar();
      const blocked = float(0).toVar();
      for (const axis of ['x', 'y', 'z'] as const) {
        partial.addAssign(face[axis].greaterThan(0).and(face[axis].lessThan(1)).select(1, 0));
        blocked.addAssign(face[axis].lessThanEqual(0).select(1, 0));
      }
      const boundary = face.w.greaterThan(0).and(face.w.lessThan(1)).or(partial.greaterThan(0));
      return vec4(boundary.select(1, 0), partial, blocked, 0);
    }, index => this.diagnosticCellActive(index));
    const values = new Float32Array(await renderer.getArrayBufferAsync(this.boundaryReduction.attribute));
    return {
      boundaryCells: Math.round(values[4] * values[8]),
      partiallyOpenFaces: Math.round(values[5] * values[8]),
      fullyBlockedFaces: Math.round(values[6] * values[8]),
    };
  }

  private collectBoundaryDiagnostics(renderer: ParticleSpatialGridRenderer): void {
    if (!this.benchmarks.enabled || this.boundaryReadPending) return;
    this.boundaryReadPending = true;
    void this.readBoundaryDiagnostics(renderer).then(stats => {
      for (const [name, value] of Object.entries(stats)) this.benchmarks.set(name, value);
    }).catch(() => {}).finally(() => { this.boundaryReadPending = false; });
  }

  protected get pressureControls(): FluidPressureControls {
    const generation = this.fluidStateGeneration;
    return {
      minIterations: this.pressureMinIterations ?? this.pressureIterations,
      maxIterations: this.pressureMaxIterations ?? this.pressureIterations,
      tolerance: this.pressureTolerance,
      warmStart: this.pressureWarmStart,
      diagnostics: this.pressureDiagnostics || this.benchmarks.enabled,
      measureVelocity: this.adaptiveTimestep,
      stage: (name, operation) => this.benchmarks.span(name, operation),
      report: stats => {
        if (generation === this.fluidStateGeneration) Object.assign(this.pressureStats, stats);
      },
    };
  }

  protected isSolid(index: Node | number = instanceIndex): Node<'bool'> {
    return this.faceOpenness.element(index).w.lessThanEqual(0);
  }

  protected targetDivergence(index: Node<'uint'>): Node<'float'> {
    void index;
    return float(0);
  }

  protected abstract solveProjection(
    renderer: ParticleSpatialGridRenderer,
    input: Vec4Storage,
    output: Vec4Storage,
  ): void;

  /** A sparse solver may prepare a replacement while physical coverage keeps using the current lattice. */
  protected prepareQualityChange(_domain: SpatialGridDomain, _renderer: ParticleSpatialGridRenderer): boolean {
    void _domain; void _renderer;
    return true;
  }

  private synchronizeGridBounds(grid: ParticleSpatialGrid, renderer: ParticleSpatialGridRenderer): void {
    if (grid.autoExpand || grid.cubicBounds || grid.centeredAtOrigin || !grid.powerOfTwoBounds) {
      grid.setOptions({ autoExpand: false, cubicBounds: false, centeredAtOrigin: false, powerOfTwoBounds: true });
    }
    const coverage = this.pendingBounds?.grid === grid ? this.pendingBounds.bounds : this.bounds;
    const ready = (domain: SpatialGridDomain) => this.prepareQualityChange(domain, renderer);
    // Coverage keeps changing in a live plume. Start/finish compatible quality preparation
    // alongside it rather than requiring a frame with no geometric growth.
    const quality = grid.resolveDeferredQuality(performance.now(), ready);
    const requested = quality ?? coverage;
    this.pendingBounds = undefined;
    const bounds = grid.resolveBounds(requested);
    if (quality || !bounds.equals(grid.bounds)) grid.setBounds(bounds);
    if (bounds.equals(this.bounds)) return;
    const previous = this.bounds.clone();
    this.previousDomain = { bounds: previous, dimensions: this.gridDimensions.clone(), cellSize: this.cellSize };
    this.bounds.copy(bounds);
    this.cellSize = grid.cellSize;
    this.boundsMinNode.value.copy(bounds.min);
    this.cellSizeNode.value = this.cellSize;
    this.guardDiagnostics.faces.forEach(face => {
      face.guardBricks = Math.max(1, Math.ceil(face.predictedTravel / grid.brickSize));
    });
    this.boundsGeneration += 1;
    this.boundsReadPending = false;
    this.onBoundsChanged(previous);
  }

  /** Persistent simulated support which can extend beyond its emitting particles. */
  protected get automaticFieldBounds(): THREE.Box3 | undefined { return undefined; }

  /** Reuse compact reductions already submitted by the particle hash and persistent-field solver. */
  protected refreshBounds(grid: ParticleSpatialGrid, renderer: ParticleSpatialGridRenderer): void {
    if (this.boundsReadPending || performance.now() - this.lastBoundsRead < 16) return;
    this.boundsReadPending = true;
    this.lastBoundsRead = performance.now();
    const generation = this.boundsGeneration, stateGeneration = this.fluidStateGeneration;
    const cellSize = grid.cellSize;
    const started = performance.now();
    const support = Promise.all([grid.readParticleBounds(renderer), this.readOccupiedFieldBounds(renderer)]);
    void support.then(async ([particles, field]) => {
      if (generation !== this.boundsGeneration || stateGeneration !== this.fluidStateGeneration
        || this.spatialGrid !== grid) return;
      this.particleBounds.copy(particles);
      this.occupiedBounds.copy(particles).union(field);
      this.benchmarks.set('boundsReadbackMs', performance.now() - started);
      if (!this.automaticPadding || !this.autoBounds || this.occupiedBounds.isEmpty()) return;
      // Coverage must not wait for another histogram dispatch/readback. Reuse the latest travel estimate.
      const coverage = grid.resolveOccupiedBounds(this.occupiedBounds, performance.now(), {
        travel: this.guardDiagnostics.faces.map(face => face.predictedTravel),
      });
      if (!coverage.equals(this.bounds)) this.pendingBounds = { grid, bounds: coverage };
      this.guardPrediction ??= new FluidGuardPrediction();
      const sources = this.guardSources();
      const faces = sources.length ? await this.guardPrediction.read(
        renderer, this.occupiedBounds.clone(), grid.brickSize, sources,
      ) : [];
      // A compatible face extension must not discard the histogram which requested its next guards.
      if (stateGeneration !== this.fluidStateGeneration || this.spatialGrid !== grid
        || cellSize !== grid.cellSize) return;
      this.guardDiagnostics.faces = faces;
      this.guardDiagnostics.observedAt = performance.now();
      this.guardDiagnostics.supportObservationAgeMs = performance.now() - started;
      const requested = grid.resolveOccupiedBounds(this.occupiedBounds, performance.now(),
        { travel: faces.map(face => face.predictedTravel) });
      if (!this.bounds.equals(requested)) this.pendingBounds = { grid, bounds: requested };
    }).catch(error => {
      if (this.benchmarks.enabled) console.warn('Fluid occupancy readback failed', error);
    }).finally(() => {
      if (generation === this.boundsGeneration) this.boundsReadPending = false;
    });
  }

  protected async prepareGuardResources(system: ParticleSystem, renderer: ParticleSpatialGridRenderer): Promise<void> {
    if (!this.automaticPadding || !this.autoBounds) return;
    this.guardContext = system.gpuSimulation.prepareContext(renderer as import('three/webgpu').WebGPURenderer);
    this.guardPrediction ??= new FluidGuardPrediction();
    await this.guardPrediction.prepare(renderer, this.guardSources());
  }

  protected guardSources(): FluidGuardSource[] {
    const context = this.guardContext;
    if (!context) return [];
    const buffers = context.buffers, tagMask = context.system.getGPUFilterTagMask(this.tags);
    let keys = this.guardParticleKeys.get(buffers);
    if (!keys) { keys = new Map(); this.guardParticleKeys.set(buffers, keys); }
    // Capacity growth replaces particle storage even though the buffer-state object survives.
    const signature = `${buffers.version}:${tagMask}`;
    let key = keys.get(signature);
    if (!key) { keys.clear(); key = {}; keys.set(signature, key); }
    return [{ key, compute: callback => Fn(() => callback(instanceIndex))().compute(buffers.count),
      sample: index => {
        const particle = buffers.storage.createParticle(index, true);
        return { position: particle.position, velocity: particle.velocity.mul(particle.speed),
          radius: max(particle.scale.x.abs(), max(particle.scale.y.abs(), particle.scale.z.abs())).mul(0.5),
          remainingLifetime: max(particle.lifetime.sub(particle.realtime.div(1000)), float(0)),
          active: particle.alive.notEqual(0).and(tagMask === undefined ? uint(1).equal(1)
            : particle.tagMask.bitAnd(uint(tagMask)).notEqual(0)) };
      } }];
  }

  /** Growth trend and observed boundary motion affect preparation, never empty-page residency. */
  protected capacityDemand(requested: number, preparationMs = 0, residentCapacity = Infinity,
    minimumLead = 0.75): number {
    const now = performance.now(), previous = this.capacityObservation;
    const growth = previous.time ? Math.max(0, requested - previous.demand)
      / Math.max((now - previous.time) / 1000, 1 / 60) : 0;
    this.capacityObservation = { demand: requested, time: now };
    const guard = Math.max(1, ...this.guardDiagnostics.faces.map(face => face.guardBricks));
    // Callers with storage-only growth can use a shorter lead; compiler-heavy FLIP keeps its reserve.
    const lead = Math.max(minimumLead, preparationMs / 1000);
    const forecast = Math.max(requested + growth * lead, requested * (1 + (guard - 1) * 0.25));
    // Forecasts start one geometric tier; only actual unmet demand may skip several tiers.
    return Math.ceil(Math.max(requested, Math.min(residentCapacity, forecast)));
  }

  protected async readOccupiedFieldBounds(_renderer: ParticleSpatialGridRenderer): Promise<THREE.Box3> {
    void _renderer;
    return new THREE.Box3();
  }

  protected onBoundsChanged(previous: THREE.Box3): void {
    void previous;
  }

  /** The grid owns the domain ceiling; the fluid module only applies particle behavior at that cap. */
  protected get boundsLimit(): THREE.Vector3 {
    return this.spatialGrid?.maxBounds ?? boundsVector(this.spatialGridOptions?.maxBounds, Infinity);
  }

  public override cleanup(): void {
    this.fluidStateGeneration++;
    this.boundaryReduction?.dispose();
    this.boundaryReduction = undefined;
    this.collectedColliders.forEach(({ collider }) => { collider.geometry = undefined; });
    this.collectedColliders.clear();
    this.colliderAtlas.dispose();
    this.collisionElapsed = 0;
    this.boundaryMotion.clear();
    this.lastParticleBuffers = undefined;
    this.guardContext = undefined;
    this.guardPrediction?.dispose(); this.guardPrediction = undefined;
    this.boundsGeneration += 1;
    this.pendingBounds = undefined;
    this.boundsReadPending = false;
    this.lastBoundsRead = 0;
    this.boundsReconcileNode = undefined;
    this.boundsReconcileKey = '';
    this.boundsReconcileBuffers = undefined;
    super.cleanup();
    this.particleCollisionBackend.destroy();
    if (this._boundsHelper) {
      this._boundsHelperSystem?.removeRendererObject(this._boundsHelper);
      [this._particleBoundsHelper, this._gridBoundsHelper].forEach((helper) => {
        helper?.geometry.dispose();
        (helper?.material as THREE.Material | undefined)?.dispose();
      });
      this._brickHelper?.dispose();
      this._brickHelper = undefined;
      this._boundsHelper = undefined;
      this._particleBoundsHelper = undefined;
      this._gridBoundsHelper = undefined;
      this._boundsHelperSystem = undefined;
    }
    this.disposeGridFields();
  }

  private updateParticleCollisionBackend(system?: ParticleSystem, dt?: number): void {
    if (!this.usesParticleColliderSweeps) return;
    const colliders = this.fluidColliders.filter((effect): effect is FluidCollider => (
      effect instanceof FluidCollider
      && effect.visible
      && effect.particleCollision
      && Boolean(effect.geometry)
    ));
    const previousThickness = this.particleCollisionThicknessValue;
    this.particleCollisionThicknessValue = colliders.reduce(
      (maximum, collider) => Math.max(maximum, collider.surfaceThickness),
      0,
    );
    this.particleCollisionThicknessNode.value = this.particleCollisionThicknessValue;
    const cacheKey = colliders
      // Bake/occupancy revisions do not replace triangle-query bindings. The backend's
      // resource version tracks actual geometry; contact radius is tracked separately.
      .map((collider) => collider.uuid)
      .join('|');
    const objects = (policies: GeometryUpdatePolicy[]) => colliders
      .filter(collider => policies.includes(collider.updatePolicy))
      .map(collider => collider.getCollisionObject());
    this.particleCollisionBackend.staticObjects = objects([GeometryUpdatePolicy.Static]);
    this.particleCollisionBackend.dynamicObjects = objects([GeometryUpdatePolicy.TransformDynamic]);
    this.particleCollisionBackend.geometryDynamicObjects = objects([
      GeometryUpdatePolicy.Auto, GeometryUpdatePolicy.GeometryDynamic,
    ]);
    if (system) this.particleCollisionBackend.materialRegistry = system.materialCopyRegistry;
    this.particleCollisionBackend.update(dt, system?.renderFrameToken);
    const nextState = this.particleCollisionBackend.hasGeometry;
    const structuralKey = `${cacheKey}:${this.particleCollisionBackend.resourceVersion}`;
    if (nextState !== this.particleCollisionState || structuralKey !== this.particleCollisionCacheKey
      || previousThickness !== this.particleCollisionThicknessValue) {
      this.particleCollisionState = nextState;
      this.particleCollisionCacheKey = structuralKey;
      this.onParticleColliderGeometryChanged();
      this.needsUpdate = true;
    }
  }

  protected get fluidColliders(): FluidCollider[] {
    return [...this.spatialEffects.get(FluidCollider),
      ...Array.from(this.collectedColliders.values(), ({ collider }) => collider)];
  }

  protected collectColliders(system: ParticleSystem): void {
    const options = this.collisionOptions;
    if (options?.surfaceThickness !== undefined && !Number.isFinite(options.surfaceThickness)) {
      throw new RangeError('Fluid collision surfaceThickness must be finite.');
    }
    if (options?.bakedFieldResolution !== undefined && (!Number.isInteger(options.bakedFieldResolution)
      || options.bakedFieldResolution < 2)) {
      throw new RangeError('Fluid collision bakedFieldResolution must be an integer of at least two.');
    }

    const selected = new Map<THREE.Mesh, GeometryUpdatePolicy>();
    const addRoot = (root: THREE.Object3D, policy?: GeometryUpdatePolicy) => {
      root.updateWorldMatrix(true, true);
      root.traverse(object => {
        if (!(object instanceof THREE.Mesh) || !object.geometry.getAttribute('position')) return;
        // Effect-owned geometry and renderer descendants already have their own lifecycle.
        for (let ancestor: THREE.Object3D | null = object; ancestor; ancestor = ancestor.parent) {
          if (ancestor instanceof FluidCollider || isIgnoredCollisionObject(ancestor)) return;
        }
        if (options?.objectFilter && !options.objectFilter(object)) return;
        const defaultPolicy = options?.updatePolicy ?? GeometryUpdatePolicy.Auto;
        const classification = policy ?? (options?.geometryDynamicObjectFilter?.(object)
          ? GeometryUpdatePolicy.GeometryDynamic : options?.dynamicObjectFilter?.(object)
            ? GeometryUpdatePolicy.TransformDynamic : options?.staticObjectFilter?.(object)
              ? GeometryUpdatePolicy.Static
              : defaultPolicy);
        selected.set(object, classification);
      });
    };

    if (options) {
      const explicit = options.staticObjects !== undefined || options.dynamicObjects !== undefined
        || options.geometryDynamicObjects !== undefined;
      if (explicit) {
        options.staticObjects?.forEach(root => addRoot(root, GeometryUpdatePolicy.Static));
        options.dynamicObjects?.forEach(root => addRoot(root, GeometryUpdatePolicy.TransformDynamic));
        options.geometryDynamicObjects?.forEach(root => addRoot(root, GeometryUpdatePolicy.GeometryDynamic));
      } else if (options.world ?? system.scene) {
        addRoot((options.world ?? system.scene)!);
      }
    }

    this.collectedColliders.forEach(({ collider }, mesh) => {
      if (!selected.has(mesh)) {
        collider.geometry = undefined;
        this.collectedColliders.delete(mesh);
      }
    });

    selected.forEach((policy, mesh) => {
      let entry = this.collectedColliders.get(mesh);
      if (!entry || entry.collider.geometry !== mesh.geometry) {
        if (entry) entry.collider.geometry = undefined;
        const collider = new CollectedFluidCollider({
          geometry: mesh.geometry,
          updatePolicy: policy,
        });
        collider.matrixAutoUpdate = false;
        entry = { collider, revision: '', lastMovedAt: this.collisionElapsed };
        this.collectedColliders.set(mesh, entry);
      }
      const { collider } = entry;
      const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material])
        .filter(material => material.visible);
      const revision = [getAttributeVersion(mesh.geometry.getAttribute('position')),
        getAttributeVersion(mesh.geometry.index), options?.surfaceThickness ?? 0,
        options?.bakedFieldResolution ?? 16, materials.map(material => material.side).join(',')].join(':');
      if (!collider.matrix.equals(mesh.matrixWorld)) {
        entry.lastMovedAt = this.collisionElapsed;
        collider.matrix.copy(mesh.matrixWorld);
        collider.matrixWorldNeedsUpdate = true;
      }
      // Automatic wrappers track geometry revisions explicitly, so rigid/static fields can be cached.
      if (revision !== entry.revision) entry.lastMovedAt = this.collisionElapsed;
      collider.updatePolicy = policy === GeometryUpdatePolicy.Auto
        ? this.collisionElapsed - entry.lastMovedAt >= Math.max(0, options?.staticAfter ?? 2)
          ? GeometryUpdatePolicy.Static : GeometryUpdatePolicy.TransformDynamic
        : policy;
      collider.surfaceThickness = Math.max(0, options?.surfaceThickness ?? 0);
      collider.bakedFieldResolution = Math.max(2, Math.floor(options?.bakedFieldResolution ?? 16));
      if (revision !== entry.revision) {
        // A closed inward-facing room contains fluid; its exterior, rather than its interior, is solid.
        collider.inverted = materials.length > 0 && materials.every(material => material.side === THREE.BackSide)
          && FluidColliderField.isClosedGeometry(mesh.geometry);
        // Rebuild a stale local BVH even when its previous classification was static or rigid.
        collider.geometry = mesh.geometry;
        collider.needsUpdate = true;
      }
      entry.revision = revision;
    });
  }

  static padBounds(bounds: THREE.Box3, ratio: number): THREE.Box3 {
    const size = bounds.getSize(new THREE.Vector3());
    const side = Math.max(size.x, size.y, size.z, 1);
    return new THREE.Box3().setFromCenterAndSize(
      bounds.getCenter(new THREE.Vector3()),
      new THREE.Vector3(1, 1, 1).multiplyScalar(side * (1 + 2 * ratio)),
    );
  }

  static padBoundsByDistance(bounds: THREE.Box3, distance: number | THREE.Vector3): THREE.Box3 {
    return typeof distance === 'number'
      ? bounds.clone().expandByScalar(Math.max(0, distance))
      : bounds.clone().expandByVector(distance.clone().max(new THREE.Vector3()));
  }

  protected updateBoundsHelper(particleSystem: ParticleSystem): void {
    if (!this.showGridHelper && !this._boundsHelper) return;
    if (!this._boundsHelper) {
      this._particleBoundsHelper = new THREE.Box3Helper(this.particleBounds, 0xffb347);
      this._particleBoundsHelper.name = 'Fluid Particle Bounds';
      this._gridBoundsHelper = new THREE.Box3Helper(this.bounds, 0x36d7e8);
      this._gridBoundsHelper.name = 'Fluid Grid Bounds';
      [this._particleBoundsHelper, this._gridBoundsHelper].forEach((helper) => {
        const material = helper.material as THREE.LineBasicMaterial;
        material.depthTest = false;
        material.depthWrite = false;
        material.opacity = 0.9;
        material.transparent = true;
        helper.renderOrder = 1000;
        helper.frustumCulled = false;
      });
      this._boundsHelper = new THREE.Group();
      this._boundsHelper.name = 'Fluid Bounds Helper';
      this._boundsHelper.add(this._gridBoundsHelper, this._particleBoundsHelper);
      this._boundsHelperSystem = particleSystem;
      particleSystem.addRendererObject(this._boundsHelper);
    }
    const grid = this.visualizationGrid;
    if (this.showGridHelper && grid && this._brickHelper?.grid !== grid) {
      if (this._brickHelper) {
        this._boundsHelper.remove(this._brickHelper);
        this._brickHelper.dispose();
      }
      this._brickHelper = new FluidGridHelper(grid);
      this._boundsHelper.add(this._brickHelper);
    }
    this._brickHelper?.updateBounds();
    this._boundsHelper.visible = this.showGridHelper;
    this._particleBoundsHelper!.visible = !this.particleBounds.isEmpty();
  }
}

export default FluidSimulation;

/** Collected meshes have a fixed baked test, rather than an arbitrary user callback. */
class CollectedFluidCollider extends FluidCollider {
  override testGPU(particle: GPUParticleLike): Node<'float'> { return this.bakedFieldGPU(particle); }

  override get canCacheGridOccupancy(): boolean {
    return this.updatePolicy === GeometryUpdatePolicy.Static
      || this.updatePolicy === GeometryUpdatePolicy.TransformDynamic;
  }
}

function attributeVersion(attribute?: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): number {
  if (!attribute) return -1;
  return 'version' in attribute ? attribute.version : attribute.data.version;
}
