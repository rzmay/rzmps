import Particle from './Particle';
import ParticleSystem from './ParticleSystem';
import type { Tag } from './types/Tag';
import type { StrictMultiple } from './types/Multiple';
import acceptMultiple from './helpers/acceptMultiple';
import tagsIntersect from './helpers/tagsIntersect';
import LODHelper, { type LODSettings } from './LODHelper';

export interface ModuleOptions {
  // -1 runs before movement updates, modules are sorted by priority afterwards
  priority: number;

  tags: StrictMultiple<Tag>;
  useUpdateLOD: boolean;
  updateLOD: Partial<LODSettings>;
}

export default class Module {
  // Sub-modules on which this module depends.
  // Useful for pre-processing or combining priority stages.
  public dependents: Module[] = [];

  tags?: Tag[];
  useUpdateLOD: boolean;
  updateLOD?: Partial<LODSettings>;
  private _lodHelper: LODHelper;

  priority = -1;

  constructor(
    public _modify: ((particle: Particle, deltaTime: number) => void),
    options: Partial<ModuleOptions> = {}
  ) {
    this.tags = acceptMultiple(options.tags);
    this.updateLOD = options.updateLOD;
    this.useUpdateLOD = options.useUpdateLOD ?? Boolean(this.updateLOD);
    this._lodHelper = new LODHelper(this.updateLOD);
    this.priority = options.priority ?? this.priority;
  }

  public modify(particles: Particle[], deltaTime: number, particleSystem?: ParticleSystem): void {
    const distanceSq = particleSystem?.cameraDistanceSq ?? Number.MAX_SAFE_INTEGER;
    if (this.useUpdateLOD && !this._lodHelper.shouldUpdate(Math.sqrt(distanceSq))) return;

    particles.filter((p) => !this.tags || tagsIntersect(this.tags, p.tags ?? []))
      .forEach((p) => this._modify(p, deltaTime));
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
  public prepare(particleSystem: ParticleSystem, deltaTime: number)  {  }

  // Optional clean up hook for modules that require it
  public cleanup() { }
}
