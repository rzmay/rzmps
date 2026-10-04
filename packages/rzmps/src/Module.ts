import Particle from './Particle';
import ParticleSystem from './ParticleSystem';
import type { Tag } from './types/Tag';
import type { StrictMultiple } from './types/Multiple';
import acceptMultiple from './helpers/acceptMultiple';
import tagsIntersect from './helpers/tagsIntersect';
import LODHelper, { type LODSettings } from './LODHelper';
import SpatialEffect from './SpatialEffect';
import Priority from './enums/Priority';
import type { GPUParticle, GPUParticleUpdateContext } from './GPUParticle';

export type ModuleUpdate = (
  particle: Particle,
  deltaTime: number,
  particleSystem?: ParticleSystem,
) => void;

export type ModuleGPUUpdate = (
  particle: GPUParticle,
  deltaTime: number,
  context: GPUParticleUpdateContext,
) => void;

export type SpatialEffectConstructor<T extends SpatialEffect = SpatialEffect> = {
  new (...args: never[]): T;
};

export interface ModuleOptions {
  // <0 runs as permanent pre-movement, 0..1 as transient pre-movement, >=1 as transient render-time.
  priority: number | Priority;

  tags: StrictMultiple<Tag>;
  condition: (particle: Particle) => boolean;
  conditionGPU: ModuleGPUUpdate | null;
  useUpdateLOD: boolean;
  updateLOD: Partial<LODSettings>;
  modifyGPU: ModuleGPUUpdate | null;
  spatialEffects: SpatialEffect[];
  spatialEffectFilter: (spatialEffect: SpatialEffect) => boolean;
  requireSpatialEffects: SpatialEffectConstructor | SpatialEffectConstructor[];
}

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
  condition: (particle: Particle) => boolean;
  conditionGPU?: ModuleGPUUpdate;
  useUpdateLOD: boolean;
  updateLOD?: Partial<LODSettings>;
  private _lodHelper: LODHelper;
  spatialEffects: SpatialEffect[] = [];
  explicitSpatialEffects?: SpatialEffect[];
  spatialEffectFilter?: (spatialEffect: SpatialEffect) => boolean;
  requireSpatialEffects?: SpatialEffectConstructor[];

  priority = Priority.Permanent;
  modifyGPU: ModuleGPUUpdate;
  requiresFreshGPUReadback = false;

  constructor(
    public _modify: ModuleUpdate,
    options: Partial<ModuleOptions> = {},
  ) {
    this.tags = acceptMultiple(options.tags);
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
  }

  get supportsGPU(): boolean {
    return this.modifyGPU !== Module.GPU_UNSUPPORTED;
  }

  public modify(particles: Particle[], deltaTime: number, particleSystem?: ParticleSystem): void {
    const distanceSq = particleSystem?.cameraDistanceSq ?? Number.MAX_SAFE_INTEGER;
    if (this.useUpdateLOD && !this._lodHelper.shouldUpdate(Math.sqrt(distanceSq))) return;

    particles.filter((p) => (
      p.alive
      && (!this.tags || tagsIntersect(this.tags, p.tags ?? []))
      && this.condition(p)
    ))
      .forEach((p) => this._modify(p, deltaTime, particleSystem));
  }

  // Process into array including self and dependents
  public withDependents(): Module[] {
    // Run dependents before this
    return [
      ...(this.dependents.flatMap(d => d.withDependents())),
      this,
    ]
  }

  // Optional preparation hook called once-per-update rather than per particle
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public prepare(particleSystem: ParticleSystem, deltaTime: number) {
    this.prepareSpatialEffects(particleSystem);
  }

  // Optional clean up hook for modules that require it
  public cleanup() { }

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
