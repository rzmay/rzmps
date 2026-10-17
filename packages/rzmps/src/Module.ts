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
  /** Execution phase: negative is permanent before movement, 0–1 is transient before movement, 1 or greater is transient after movement. */
  priority: number | Priority;

  /** Restricts processing to particles sharing a selected tag; omission accepts every tag. */

  tags: StrictMultiple<Tag>;
  /** Additional per-particle predicate, evaluated after tag matching. */
  condition: (particle: Particle) => boolean;
  /** Enables distance-based module update skipping. */
  useUpdateLOD: boolean;
  /** Module update quality settings; skipped callbacks do not accumulate their own delta. */
  updateLOD: Partial<LODSettings>;
  /** Explicit module effect collection; supplying an empty array suppresses automatic discovery. */
  spatialEffects: SpatialEffect[];
  /** Filters effects collected by this module. */
  spatialEffectFilter: (spatialEffect: SpatialEffect) => boolean;
  /** Constructors selecting scene effects for this module during prepare. */
  requireSpatialEffects: SpatialEffectConstructor | SpatialEffectConstructor[];
}

/** Per-particle modifier with priority phases, tag filtering, and a once-per-update preparation hook. */
export default class Module {
  public static readonly Priority = Priority;

  // Sub-modules on which this module depends.
  // Useful for pre-processing or combining priority stages.
  public dependents: Module[] = [];

  tags?: Tag[];
  condition: (particle: Particle) => boolean;
  useUpdateLOD: boolean;
  updateLOD?: Partial<LODSettings>;
  private _lodHelper: LODHelper;
  spatialEffects: SpatialEffect[] = [];
  explicitSpatialEffects?: SpatialEffect[];
  spatialEffectFilter?: (spatialEffect: SpatialEffect) => boolean;
  requireSpatialEffects?: SpatialEffectConstructor[];

  priority = Priority.Permanent;

  /** Wraps a per-particle callback; options select filtering, spatial collection, and priority. */
  constructor(
    public _modify: ModuleUpdate,
    options: Partial<ModuleOptions> = {}
  ) {
    this.tags = acceptMultiple(options.tags);
    this.condition = options.condition ?? (() => true);
    this.updateLOD = options.updateLOD;
    this.useUpdateLOD = options.useUpdateLOD ?? Boolean(this.updateLOD);
    this._lodHelper = new LODHelper(this.updateLOD);
    this.priority = options.priority ?? this.priority;
    this.explicitSpatialEffects = options.spatialEffects;
    this.spatialEffectFilter = options.spatialEffectFilter;
    this.requireSpatialEffects = acceptMultiple(options.requireSpatialEffects);
  }

  /** Applies tag, condition, and LOD selection before invoking the particle callback. */
  public modify(particles: Particle[], deltaTime: number, particleSystem?: ParticleSystem): void {
    const distanceSq = particleSystem?.cameraDistanceSq ?? Number.MAX_SAFE_INTEGER;
    if (this.useUpdateLOD && !this._lodHelper.shouldUpdate(Math.sqrt(distanceSq))) return;

    particles.filter((p) => (
      (!this.tags || tagsIntersect(this.tags, p.tags ?? []))
      && this.condition(p)
    ))
      .forEach((p) => this._modify(p, deltaTime, particleSystem));
  }

  // Process into array including self and dependents
  /** Flattens dependents before this module; priority sorting still determines execution phases. */
  public withDependents(): Module[] {
    // Run dependents before this
    return [
      ...(this.dependents.flatMap(d => d.withDependents())),
      this,
    ]
  }

  // Optional preparation hook called once-per-update rather than per particle
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  /** Prepares shared work once per system update; the base implementation collects matching spatial effects. */
  public prepare(particleSystem: ParticleSystem, deltaTime: number)  {
    this.prepareSpatialEffects(particleSystem);
  }

  // Optional clean up hook for modules that require it
  /** Extension hook to release temporary resources when the owning system is cleaned up. */
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
