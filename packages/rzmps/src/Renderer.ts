import Particle from './Particle';
import ParticleSystem from './ParticleSystem';
import type { StrictMultiple } from './types/Multiple';
import type { Tag } from './types/Tag';
import acceptMultiple from './helpers/acceptMultiple';
import tagsIntersect from './helpers/tagsIntersect';
import type { DynamicUntimedValue } from './types/DynamicValue';
import type { ValueByParameter } from './types/ValueByParameter';
import { MathUtils, Vector3 } from 'three';
import seedrandom from 'seedrandom';
import evaluateDynamicNumber from './helpers/evaluateDynamicNumber';
import evaluateByParameterNumber from './helpers/evaluateByParameterNumber';
import GPURendererChildren from './gpu/RendererChildren';
import type { GPUParticleBufferState, GPUParticleRenderBufferState } from './gpu/Particle';
import type { Node } from 'three/webgpu';
import { bitAnd, float, uint, uniform } from 'three/tsl';
import { GPUDynamicParameterStore } from './helpers/evaluateDynamicGPU';
import type { GPUParticleReadbackField } from './gpu/SelectiveReadback';

export enum CompensationMode {
  None = 'none',
  Size = 'size',
  Children = 'children',
}

export interface RendererChildrenOptions {
  /** Additional visual copies. Counts are floored and clamped to nonnegative integers. */
  count?: DynamicUntimedValue<number>;
  radius?: number;
  /** Radial multiplier; numeric values are constant. */
  scale?: ValueByParameter<number>;
  /** Radial multiplier; numeric values are constant. */
  alpha?: ValueByParameter<number>;
  randomizeScale?: number;
  randomizeAlpha?: number;
  radialFalloff?: (parameter: number) => number;
}

export interface RendererOptions {
  /** Filters the simulated population by tag before rendering. */
  tags: StrictMultiple<Tag>;
  /** Artistic render-only copies, generated before LOD children. */
  children: RendererChildrenOptions;
  /** Visual approximation for population removed by system LOD. Defaults to none. */
  compensation: CompensationMode | `${CompensationMode}`;
}

/** Base renderer that filters particles and applies renderer LOD before delegating to a backend-compatible view. */
export default abstract class Renderer {
  tags?: Tag[];
  children: RendererChildrenOptions;
  compensation: CompensationMode | `${CompensationMode}`;
  private readonly _gpuQuality = uniform(1, 'float');
  private readonly _gpuChildren = new GPURendererChildren();
  private _gpuReadbackPending = false;
  private _gpuReadbackSequence = 0;
  private _version = 0;
  private _gpuConfigurationSignature = '';
  private _gpuParameterVersion = 0;
  protected readonly gpuParameters = new GPUDynamicParameterStore();

  get version(): number {
    return this._version;
  }

  get gpuParameterUploadCount(): number {
    return this.gpuParameters.uploadCount;
  }

  set needsUpdate(value: boolean) {
    if (value) {
      this._version += 1;
      this.onGPUConfigurationChange();
    }
  }

  /** Configures particle filtering, artistic children, and LOD compensation. */
  constructor(options: Partial<RendererOptions> = {}) {
    this.tags = acceptMultiple(options.tags);
    this.children = options.children ?? {};
    this.compensation = options.compensation ?? CompensationMode.None;
  }

  // Runs once, when the renderer is added to the system
  /** Creates rendering resources when attached to a system. */
  public abstract setup(system: ParticleSystem): void;

  protected abstract _update(
    particles: Particle[],
    system: ParticleSystem,
    deltaTime: number,
  ): void;

  /** Whether this renderer can consume GPU particle buffers without a selective CPU readback. */
  get supportsGPUInput(): boolean {
    return this._updateGPU !== Renderer.prototype._updateGPU;
  }

  /** Synchronizes runtime values and invalidates structural GPU changes. */
  public syncGPUConfiguration(): void {
    this.gpuParameters.sync();
    if (this.gpuParameters.version !== this._gpuParameterVersion) {
      this._gpuParameterVersion = this.gpuParameters.version;
      this._version += 1;
      this.onGPUConfigurationChange();
    }

    const signature = [
      this.tags?.join('|') ?? '',
      this.compensation,
      JSON.stringify(this.children, (_key, value) => {
        if (typeof value === 'function') return value.toString();
        return value instanceof Set ? [...value] : value;
      }),
      this.getGPUConfigurationSignature(),
    ].join(';');
    if (this._gpuConfigurationSignature && signature !== this._gpuConfigurationSignature) {
      this._version += 1;
      this.onGPUConfigurationChange();
    }
    this._gpuConfigurationSignature = signature;
  }

  protected getGPUConfigurationSignature(): string {
    return '';
  }

  protected onGPUConfigurationChange(): void { }

  /** Consumes GPU simulation or render-output storage without materializing CPU particles. */
  protected _updateGPU(
    buffers: GPUParticleBufferState | GPUParticleRenderBufferState,
    system: ParticleSystem,
    deltaTime: number = 0,
  ): void {
    void buffers;
    void system;
    void deltaTime;
    throw new Error('This particle renderer does not support GPU particle buffers.');
  }

  /** Expands render-only children and compensation before delegating to the view. */
  public update(
    particles: Particle[],
    system: ParticleSystem,
    deltaTime: number = 0,
  ): void {
    const visible = system.quality === 0 ? [] : particles.filter(particle => (
      !this.tags || tagsIntersect(this.tags, particle.tags ?? [])
    ));
    const originalCount = visible.length;
    const childCounts: number[] = [];

    // Add artistic renderer children to the simulated population.
    for (let i = 0; i < originalCount; i++) {
      const parent = visible[i];
      const value = evaluateDynamicNumber(this.children.count ?? 0, 0, `${parent.id}:count`);
      const count = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
      childCounts[i] = count;
      for (let child = 0; child < count; child++) {
        visible.push(this.generateChild(parent, child, Math.max(0, this.children.radius ?? 0), true));
      }
    }

    // Compensate for LOD after artistic children, preserving their scale and alpha.
    if (this.compensation === CompensationMode.Children && system.quality > 0 && system.quality < 1) {
      const additional = 1 / system.quality - 1;
      const full = Math.floor(additional);
      const population = visible.length;
      for (let i = 0; i < population; i++) {
        const parent = visible[i];
        const firstChild = childCounts[i] ?? 0;
        const selected = seedrandom(`${parent.id}[${firstChild + full}]`).quick() < additional - full;
        const count = full + (selected ? 1 : 0);
        const radius = system.getParticleSpacing(parent.root, particles);
        for (let child = 0; child < count; child++) {
          visible.push(this.generateChild(parent, firstChild + child, radius, false));
        }
      }
    } else if (this.compensation === CompensationMode.Size && system.quality > 0 && system.quality < 1) {
      for (let i = 0; i < visible.length; i++) {
        visible[i] = visible[i].shallowClone(visible[i].id, {
          scale: visible[i].scale.clone().multiplyScalar(1 / Math.sqrt(system.quality)),
        });
      }
    }

    this._update(visible, system, deltaTime);
  }

  private generateChild(parent: Particle, ordinal: number, radius: number, applyDistanceScaling: boolean): Particle {
    const child = parent.shallowClone(`${parent.id}[${ordinal}]`, { position: new Vector3() });
    child.parent = parent;

    const random = seedrandom(child.id);
    const distance = Math.cbrt(random.quick());
    child.position.setFromSphericalCoords(
      distance * radius,
      Math.acos(2 * random.quick() - 1),
      random.quick() * Math.PI * 2,
    ).add(parent.position);

    if (applyDistanceScaling) {
      const options = this.children;
      const multiplier = (value: ValueByParameter<number> | undefined, amount: number, stream: string) => {
        const variation = seedrandom(`${child.id}:${stream}`).quick() - 0.5;
        let t = MathUtils.clamp((radius > 0 ? distance : 0) + amount * variation, 0, 1);
        if (options.radialFalloff) t = options.radialFalloff(t);
        return typeof value === 'number' || value === undefined ? value ?? 1 : evaluateByParameterNumber(value, t);
      };
      const scale = multiplier(options.scale, options.randomizeScale ?? 0, 'scale');
      if (scale !== 1) child.scale = parent.scale.clone().multiplyScalar(scale);
      child.alpha *= multiplier(options.alpha, options.randomizeAlpha ?? 0, 'alpha');
    }

    return child;
  }

  /** Base-class GPU preprocessing; subclasses consume the resulting ordinary render view. */
  public updateGPU(
    buffers: GPUParticleBufferState | GPUParticleRenderBufferState,
    system: ParticleSystem,
    deltaTime: number = 0,
  ): void {
    if (!this.supportsGPUInput) throw new Error('This particle renderer does not support GPU particle buffers.');
    // Readback implementations expand once through the CPU update entry point.
    const visual = this.updateGPUUsesCPUReadback ? buffers : this._gpuChildren.prepare(
      buffers,
      system,
      this.children,
      this.compensation,
      this.version,
      system.getGPURendererTagMask(this.tags),
    );
    this._updateGPU(visual, system, deltaTime);
  }

  protected get updateGPUUsesCPUReadback(): boolean {
    return false;
  }

  protected prepareGPUVisibility(system: ParticleSystem): void {
    this._gpuQuality.value = system.quality;
  }

  protected getGPUVisibilityNode(
    particle: {
      index: Node<'uint'>;
      alive: Node<'uint'>;
      tagMask: Node<'uint'>;
      generation: Node<'uint'>;
    },
    system: ParticleSystem,
  ): Node<'float'> {
    let visible = particle.alive.notEqual(uint(0)).and(this._gpuQuality.greaterThan(float(0)));
    const tagMask = system.getGPURendererTagMask(this.tags);
    if (tagMask !== undefined) {
      visible = visible.and(bitAnd(particle.tagMask, uint(tagMask)).notEqual(uint(0)));
    }
    return visible.select(float(1), float(0)) as Node<'float'>;
  }

  protected getGPUScaleMultiplierNode(): Node<'float'> {
    if (this.compensation !== CompensationMode.Size) return float(1);
    return float(1).div(this._gpuQuality.max(float(1e-8)).sqrt()) as Node<'float'>;
  }

  /**
   * Selectively reads GPU particle fields and forwards the resulting particles through
   * {@link update}. Use this from {@link _updateGPU} when a renderer consumes CPU particle
   * objects instead of GPU storage directly. Omit `fields` only when the renderer needs the
   * complete particle state.
   */
  protected updateCPUFromGPU(
    buffers: GPUParticleBufferState | GPUParticleRenderBufferState,
    system: ParticleSystem,
    deltaTime: number,
    limit = buffers.count,
    fields?: readonly GPUParticleReadbackField[],
  ): void {
    if (this._gpuReadbackPending) return;
    const sequence = this._gpuReadbackSequence + 1;
    this._gpuReadbackSequence = sequence;
    this._gpuReadbackPending = true;
    void system.selectiveReadback(Math.min(buffers.count, limit), fields)
      .then((results) => {
        if (sequence !== this._gpuReadbackSequence) return;
        this.update(
          results.filter((result) => result.valid).map((result) => result.particle),
          system,
          deltaTime,
        );
      })
      .finally(() => {
        if (sequence === this._gpuReadbackSequence) this._gpuReadbackPending = false;
      });
  }

  protected cancelGPUSelectiveReadback(): void {
    this._gpuReadbackSequence += 1;
    this._gpuReadbackPending = false;
  }

  /** Restores transient backend state while retaining reusable rendering resources. */
  public reset(): void {
    this.cancelGPUSelectiveReadback();
    this._gpuChildren.reset();
  }

  // Cleanup
  /** Permanently releases owned rendering resources. */
  public abstract destroy(): void;
  /** Removes displayed particles while retaining resources for reuse. */
  public abstract clear(): void;
}
