import Particle from './Particle';
import ParticleSystem from './ParticleSystem';
import type { Tag } from './types/Tag';
import type { StrictMultiple } from './types/Multiple';
import acceptMultiple from './helpers/acceptMultiple';
import tagsIntersect from './helpers/tagsIntersect';
import LODHelper, { type LODSettings } from './LODHelper';
import SpatialEffect from './SpatialEffect';
import Priority from './enums/Priority';
import type { GPUParticleLike, GPUParticleRenderBufferState, GPUParticleUpdateContext } from './gpu/Particle';
import type { Node } from 'three/webgpu';
import { GPUDynamicParameterStore } from './helpers/evaluateDynamicGPU';
import ParticleSpatialGrid, {
  type ParticleSpatialGridOptions,
  type ParticleSpatialGridRenderer
} from './gpu/ParticleSpatialGrid';
import ParticleOctree, {
  type OctreeAggregator,
  type OctreeConfig,
} from './helpers/ParticleOctree';

export interface ModuleOctreeAggregate {
  count: number;
}

export type ModuleUpdate = (
  particle: Particle,
  deltaTime: number,
  particleSystem?: ParticleSystem,
  octree?: ParticleOctree<unknown>,
) => void;

export type ModuleCondition = (
  particle: Particle,
  deltaTime: number,
  particleSystem?: ParticleSystem,
  octree?: ParticleOctree<unknown>,
) => boolean;

export type ModuleGPUUpdate = (
  /** Shader-node particle view; mutate fields through TSL assignment methods. */
  particle: GPUParticleLike,
  deltaTime: Node<'float'>,
  context: GPUParticleUpdateContext,
  spatialGrid?: ParticleSpatialGrid,
) => void;

export type ModuleGPUCondition = (
  particle: GPUParticleLike,
  deltaTime: Node<'float'>,
  context: GPUParticleUpdateContext,
  spatialGrid?: ParticleSpatialGrid,
) => Node<'bool'>;

export type SpatialEffectConstructor<T extends SpatialEffect = SpatialEffect> = {
  new (...args: never[]): T;
};

export interface ModuleOptions {
  // <0 runs as permanent pre-movement, 0..1 as transient pre-movement, >=1 as transient render-time.
  /** Execution phase:
   * negative is permanent before movement,
   * 0–1 is transient before movement,
   * 1 or greater is transient after movement.
  */
  priority: number | Priority;

  /** Restricts processing to particles sharing a selected tag; omission accepts every tag. */

  tags: StrictMultiple<Tag>;
  /** Additional per-particle predicate, evaluated after tag matching. */
  condition: ModuleCondition;
  /** Optional TSL condition callback for GPU processing. */
  conditionGPU: ModuleGPUCondition | null;
  /** Enables distance-based module update skipping. */
  useUpdateLOD: boolean;
  /** Module update quality settings; skipped callbacks do not accumulate their own delta. */
  updateLOD: Partial<LODSettings>;
  /** TSL modifier used when GPU processing is active. */
  modifyGPU: ModuleGPUUpdate | null;
  /** Explicit module effect collection; supplying an empty array suppresses automatic discovery. */
  spatialEffects: SpatialEffect[];
  /** Filters effects collected by this module. */
  spatialEffectFilter: (spatialEffect: SpatialEffect) => boolean;
  /** Constructors selecting scene effects for this module during prepare. */
  requireSpatialEffects: SpatialEffectConstructor | SpatialEffectConstructor[];
  /** Enables a managed CPU ParticleOctree with default options. */
  useOctree: boolean;
  /** Configures and implicitly enables the managed CPU ParticleOctree. */
  octreeOptions: Partial<OctreeConfig>;
  /** Aggregate factory used while rebuilding the managed CPU ParticleOctree. */
  octreeAggregator: OctreeAggregator<unknown>;
  /** Enables a managed GPU ParticleSpatialGrid with default options. */
  useSpatialGrid: boolean;
  /** Configures and implicitly enables the managed GPU ParticleSpatialGrid. */
  spatialGridOptions: Partial<ParticleSpatialGridOptions>;
}

/** Per-particle modifier with priority phases, tag filtering, and a once-per-update preparation hook. */
export default class Module {
  public static readonly Priority = Priority;

  static CPU_UNSUPPORTED: ModuleUpdate = () => {
    throw new Error('This particle module does not support CPU processing.');
  };

  static GPU_UNSUPPORTED: ModuleGPUUpdate = () => {
    throw new Error('This particle module does not support GPU processing.');
  };

  // Sub-modules on which this module depends.
  // Useful for pre-processing or combining priority stages.
  public dependents: Module[] = [];

  tags?: Tag[];
  condition: ModuleCondition;
  conditionGPU?: ModuleGPUCondition;
  private readonly _hasCustomCondition: boolean;
  useUpdateLOD: boolean;
  updateLOD?: Partial<LODSettings>;
  private _lodHelper: LODHelper;
  spatialEffects: SpatialEffect[] = [];
  explicitSpatialEffects?: SpatialEffect[];
  spatialEffectFilter?: (spatialEffect: SpatialEffect) => boolean;
  requireSpatialEffects?: SpatialEffectConstructor[];
  octree?: ParticleOctree<unknown>;
  readonly useOctree: boolean;
  readonly octreeOptions: Partial<OctreeConfig>;
  readonly octreeAggregator: OctreeAggregator<unknown>;
  readonly useSpatialGrid: boolean;
  spatialGridOptions?: Partial<ParticleSpatialGridOptions>;
  protected spatialGrid?: ParticleSpatialGrid;

  priority = Priority.Permanent;
  modifyGPU: ModuleGPUUpdate;
  protected readonly gpuParameters = new GPUDynamicParameterStore();
  private _gpuParameterVersion = 0;
  private _version = 0;
  private _gpuStructureSignature = '';

  get version(): number {
    return this._version;
  }

  get gpuParameterUploadCount(): number {
    return this.gpuParameters.uploadCount;
  }

  set needsUpdate(value: boolean) {
    if (value) this._version += 1;
  }

  /** Wraps a per-particle callback; options select filtering, spatial collection, and priority. */
  constructor(
    public _modify: ModuleUpdate,
    options: Partial<ModuleOptions> = {},
  ) {
    this.tags = acceptMultiple(options.tags);
    this._hasCustomCondition = options.condition !== undefined;
    this.condition = options.condition ?? (() => true);
    this.conditionGPU = options.conditionGPU ?? undefined;
    this.updateLOD = options.updateLOD;
    this.useUpdateLOD = options.useUpdateLOD ?? Boolean(this.updateLOD);
    this._lodHelper = new LODHelper(this.updateLOD);
    this.priority = options.priority ?? this.priority;
    this.modifyGPU = options.modifyGPU ?? Module.GPU_UNSUPPORTED;
    this.explicitSpatialEffects = options.spatialEffects;
    this.spatialEffectFilter = options.spatialEffectFilter;
    this.requireSpatialEffects = acceptMultiple(options.requireSpatialEffects);
    this.useOctree = options.useOctree ?? options.octreeOptions !== undefined;
    this.octreeOptions = options.octreeOptions ?? {};
    this.octreeAggregator = options.octreeAggregator ?? createDefaultOctreeAggregator();
    this.useSpatialGrid = options.useSpatialGrid ?? options.spatialGridOptions !== undefined;
    this.spatialGridOptions = options.spatialGridOptions;
  }

  /** Whether both modification and any custom condition have GPU implementations. */
  get supportsGPU(): boolean {
    return this.modifyGPU !== Module.GPU_UNSUPPORTED
      && (!this._hasCustomCondition || this.conditionGPU !== undefined);
  }

  public syncGPUConfiguration(): void {
    this.gpuParameters.sync();
    if (this.gpuParameters.version !== this._gpuParameterVersion) {
      this._gpuParameterVersion = this.gpuParameters.version;
      this._version += 1;
    }

    const options = (this as Module & { options?: unknown }).options;
    const structureSignature = getGPUValueStructure(options);
    if (this._gpuStructureSignature && structureSignature !== this._gpuStructureSignature) {
      this._version += 1;
    }
    this._gpuStructureSignature = structureSignature;
  }

  /** Applies tag, condition, and LOD selection before invoking the particle callback. */
  public modify(particles: Particle[], deltaTime: number, particleSystem?: ParticleSystem): void {
    const distanceSq = particleSystem?.cameraDistanceSq ?? Number.MAX_SAFE_INTEGER;
    if (this.useUpdateLOD && !this._lodHelper.shouldUpdate(Math.sqrt(distanceSq))) return;

    particles.filter((p) => (
      p.alive
      && (!this.tags || tagsIntersect(this.tags, p.tags ?? []))
      && this.condition(p, deltaTime, particleSystem, this.octree)
    ))
      .forEach((p) => this._modify(p, deltaTime, particleSystem, this.octree));
  }

  /** Flattens dependents before this module; priority sorting still determines execution phases. */
  public withDependents(): Module[] {
    // Run dependents before this
    return [
      ...(this.dependents.flatMap(d => d.withDependents())),
      this,
    ]
  }

  /** Prepares shared work once per system update; the base implementation collects matching spatial effects. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public prepare(particleSystem: ParticleSystem, deltaTime: number) {
    this.prepareSpatialEffects(particleSystem);
    if (!this.useOctree || particleSystem.isGPUProcessingActive) return;

    let bounds = this.octreeOptions.bounds;
    if (!bounds) {
      if (particleSystem.boundingBox.isEmpty()) particleSystem.updateBoundingBox();
      if (!particleSystem.boundingBox.isEmpty()) bounds = particleSystem.boundingBox;
    }

    if (!this.octree) {
      this.octree = new ParticleOctree(
        { tags: this.tags, ...this.octreeOptions, bounds: bounds?.clone() },
        this.octreeAggregator,
      );
    } else if (!this.octreeOptions.bounds && bounds) {
      this.octree.setBounds(bounds);
    }
    this.octree.tags = this.octreeOptions.tags ?? this.tags;
    this.octree.rebuild(particleSystem.particles);
  }

  /** Returns the managed CPU structure after prepare(), when enabled. */
  public getParticleOctree(): ParticleOctree<unknown> | undefined {
    return this.octree;
  }

  /** Dependency hook used by function-defined and class-based GPU neighbor modules. */
  public getParticleSpatialGrid(particleSystem: ParticleSystem): ParticleSpatialGrid | undefined {
    if (!this.useSpatialGrid) return undefined;
    this.spatialGrid ??= particleSystem.acquireParticleSpatialGrid(
      this.spatialGridOptions ?? {},
    );
    return this.spatialGrid;
  }

  /** Updates managed-grid configuration. Subdivision changes acquire a newly sized grid. */
  public setSpatialGridOptions(options: Partial<ParticleSpatialGridOptions>): this {
    this.spatialGridOptions ??= {};
    const structural = options.brickSubdivisions !== undefined
      || options.cellSubdivisions !== undefined;
    Object.assign(this.spatialGridOptions, options);
    if (structural) this.spatialGrid = undefined;
    else this.spatialGrid?.setOptions(options);
    this.needsUpdate = true;
    return this;
  }

  /** Optional GPU compute pass, scheduled after the spatial grid is built and before this module modifies particles. */
  public computeGPU(
    _context: GPUParticleUpdateContext,
    _renderer: ParticleSpatialGridRenderer,
    _grid?: ParticleSpatialGrid,
  ): void {
    void _context;
    void _renderer;
    void _grid;
  }

  /** Optional render-time GPU pass, after transient particle attributes have been evaluated. */
  public renderGPU(
    _context: GPUParticleUpdateContext,
    _renderBuffers: GPUParticleRenderBufferState,
    _renderer: ParticleSpatialGridRenderer,
    _grid?: ParticleSpatialGrid,
  ): void {
    void _context;
    void _renderBuffers;
    void _renderer;
    void _grid;
  }

  // Optional clean up hook for modules that require it
  /** Releases managed CPU and GPU spatial acceleration references. */
  public cleanup() {
    this.octree = undefined;
    this.spatialGrid = undefined;
  }

  protected prepareSpatialEffects(particleSystem: ParticleSystem): void {
    if (Array.isArray(this.explicitSpatialEffects)) {
      this.spatialEffects = this.explicitSpatialEffects
        .filter((effect) => (
          (!this.requireSpatialEffects?.length
            || this.requireSpatialEffects.some((constructor) => effect instanceof constructor))
          && (!this.spatialEffectFilter || this.spatialEffectFilter(effect))
        ));
      return;
    }

    this.spatialEffects = [];

    if (!this.requireSpatialEffects?.length) return;

    particleSystem.scene?.traverse((object) => {
      if (
        object instanceof SpatialEffect
        && (!this.requireSpatialEffects?.length
          || this.requireSpatialEffects.some((constructor) => object instanceof constructor))
        && (!this.spatialEffectFilter || this.spatialEffectFilter(object))
      ) this.spatialEffects.push(object);
    });
  }
}

function createDefaultOctreeAggregator(): OctreeAggregator<ModuleOctreeAggregate> {
  return {
    new: (particle) => ({ count: particle ? 1 : 0 }),
    combine: (a, b) => ({ count: a.count + b.count }),
  };
}

function getGPUValueStructure(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return `${typeof value}:${value}`;
  if (typeof value === 'number' || typeof value === 'function') return typeof value;
  if (Array.isArray(value)) return `array:${value.map(getGPUValueStructure).join(',')}`;
  if (value instanceof Set) return `set:${Array.from(value).map(getGPUValueStructure).join(',')}`;
  if (typeof value !== 'object') return typeof value;

  const record = value as Record<string, unknown>;
  if ('isNode' in record) return 'node';
  const constructorName = value.constructor?.name ?? 'Object';
  if (constructorName !== 'Object') return constructorName;
  return `object:${Object.keys(record).sort().map((key) => `${key}=${getGPUValueStructure(record[key])}`).join(',')}`;
}
