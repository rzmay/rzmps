import Particle from './Particle';
import ParticleSystem from './ParticleSystem';
import type { Tag } from './types/Tag';
import type { StrictMultiple } from './types/Multiple';
import acceptMultiple from './helpers/acceptMultiple';
import tagsIntersect from './helpers/tagsIntersect';
import LODHelper, { type LODSettings } from './LODHelper';
import SpatialEffect from './SpatialEffect';
import Priority from './enums/Priority';

export type ModuleUpdate = (
  particle: Particle,
  deltaTime: number,
  particleSystem?: ParticleSystem,
) => void;

export type SpatialEffectConstructor<T extends SpatialEffect = SpatialEffect> = {
  new (...args: never[]): T;
};

export interface ModuleOptions {
  // <0 runs as permanent pre-movement, 0..1 as transient pre-movement, >=1 as transient render-time.
  priority: number | Priority;

  tags: StrictMultiple<Tag>;
  useUpdateLOD: boolean;
  updateLOD: Partial<LODSettings>;
  spatialEffects: SpatialEffect[];
  spatialEffectFilter: (spatialEffect: SpatialEffect) => boolean;
  requireSpatialEffects: SpatialEffectConstructor | SpatialEffectConstructor[];
}

export default class Module {
  public static readonly Priority = Priority;

  // Sub-modules on which this module depends.
  // Useful for pre-processing or combining priority stages.
  public dependents: Module[] = [];

  tags?: Tag[];
  useUpdateLOD: boolean;
  updateLOD?: Partial<LODSettings>;
  private _lodHelper: LODHelper;
  spatialEffects: SpatialEffect[] = [];
  explicitSpatialEffects?: SpatialEffect[];
  spatialEffectFilter?: (spatialEffect: SpatialEffect) => boolean;
  requireSpatialEffects?: SpatialEffectConstructor[];

  priority = Priority.Permanent;

  constructor(
    public _modify: ModuleUpdate,
    options: Partial<ModuleOptions> = {}
  ) {
    this.tags = acceptMultiple(options.tags);
    this.updateLOD = options.updateLOD;
    this.useUpdateLOD = options.useUpdateLOD ?? Boolean(this.updateLOD);
    this._lodHelper = new LODHelper(this.updateLOD);
    this.priority = options.priority ?? this.priority;
    this.explicitSpatialEffects = options.spatialEffects;
    this.spatialEffectFilter = options.spatialEffectFilter;
    this.requireSpatialEffects = acceptMultiple(options.requireSpatialEffects);
  }

  public modify(particles: Particle[], deltaTime: number, particleSystem?: ParticleSystem): void {
    const distanceSq = particleSystem?.cameraDistanceSq ?? Number.MAX_SAFE_INTEGER;
    if (this.useUpdateLOD && !this._lodHelper.shouldUpdate(Math.sqrt(distanceSq))) return;

    particles.filter((p) => !this.tags || tagsIntersect(this.tags, p.tags ?? []))
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
  public prepare(particleSystem: ParticleSystem, deltaTime: number)  {
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
