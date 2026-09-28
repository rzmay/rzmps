import Particle from './Particle';
import ParticleSystem from './ParticleSystem';
import type { Tag } from './types/Tag';
import type { StrictMultiple } from './types/Multiple';
import acceptMultiple from './helpers/acceptMultiple';
import tagsIntersect from './helpers/tagsIntersect';
import LODHelper, { type LODSettings } from './LODHelper';
import type { GPUParticle, GPUParticleUpdateContext } from './GPUParticle';

export type ModuleUpdate = (particle: Particle, deltaTime: number) => void;
export type ModuleGPUUpdate = (
  particle: GPUParticle,
  deltaTime: number,
  context: GPUParticleUpdateContext,
) => void;

export interface ModuleOptions {
  // <0 runs as permanent pre-movement, 0..1 as transient pre-movement, >=1 as transient render-time.
  priority: number;

  tags: StrictMultiple<Tag>;
  useUpdateLOD: boolean;
  updateLOD: Partial<LODSettings>;
  modifyGPU: ModuleGPUUpdate | null;
}

export default class Module {
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
  useUpdateLOD: boolean;
  updateLOD?: Partial<LODSettings>;
  private _lodHelper: LODHelper;

  priority = -1;
  modifyGPU: ModuleGPUUpdate;

  constructor(
    public _modify: ModuleUpdate,
    options: Partial<ModuleOptions> = {}
  ) {
    this.tags = acceptMultiple(options.tags);
    this.updateLOD = options.updateLOD;
    this.useUpdateLOD = options.useUpdateLOD ?? Boolean(this.updateLOD);
    this._lodHelper = new LODHelper(this.updateLOD);
    this.priority = options.priority ?? this.priority;
    this.modifyGPU = options.modifyGPU ?? Module.GPU_UNSUPPORTED;
  }

  get supportsGPU(): boolean {
    return this.modifyGPU !== Module.GPU_UNSUPPORTED;
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
