import Particle from './Particle';
import ParticleSystem from './ParticleSystem';
import { Tag } from './types/Tag';
import { StrictMultiple } from './types/Multiple';
import acceptMultiple from './helpers/acceptMultiple';
import tagsIntersect from './helpers/tagsIntersect';

export interface ModuleOptions {
  // -1 runs before movement updates, modules are sorted by priority afterwards
  priority: number;

  tags: StrictMultiple<Tag>;
}

export default class Module {
  // Sub-modules on which this module depends.
  // Useful for pre-processing or combining priority stages.
  public dependents: Module[] = [];

  tags?: Tag[];

  priority = -1;

  constructor(
    public _modify: ((particle: Particle, deltaTime: number) => void),
    options: Partial<ModuleOptions> = {}
  ) {
    this.tags = acceptMultiple(options.tags);
    this.priority = options.priority ?? this.priority;
  }

  public modify(particles: Particle[], deltaTime: number): void {
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
