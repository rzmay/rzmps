import type { ParticleCondition, ParticleGPUCondition } from './particleCondition.types';
import GPURendererSelection from '../rendering/gpu/GPURendererSelection';
import { BenchmarkMetricType } from '../enums/BenchmarkMetricType';
import type { Vector3Input } from '../values/valueInput.types';
import evaluateByParameterVector3 from '../values/evaluateByParameterVector3';
import type { MaterialCompositeCallback, MaterialCompositeGPUCallback } from '../rendering/compositing/composite.utils';
import Appearance from '../rendering/compositing/Appearance';
import type { TextureAtlasOptions } from '../rendering/TextureAtlas';
import {
  MaterialCopyRegistry,
  MaterialCopySampleMode,
  type MaterialTarget,
} from '../rendering/compositing/MaterialCopyRegistry';
import EventReceiver, { type EventReceiverOptions } from '../events/EventReceiver';
import Particle from './Particle';
import groupRendererParticles, { rendererGroupCount } from '../rendering/groupRendererParticles';
import GPURendererGrouping from '../rendering/gpu/GPURendererGrouping';
import ParticleSystem from './ParticleSystem';
import type { StrictMultiple } from '../types/multiple.types';
import type { Tag } from '../types/tag.types';
import acceptMultiple from '../utils/acceptMultiple';
import tagsIntersect from './tags/tagsIntersect';
import type { DynamicValue, DynamicUntimedValue } from '../values/dynamicValue.types';
import type { ValueByParameter } from '../values/valueByParameter.types';
import { Euler, Quaternion, MathUtils, Texture, Vector3, type Material } from 'three';
import seedrandom from 'seedrandom';
import evaluateDynamicNumber from '../values/evaluateDynamicNumber';
import evaluateByParameterNumber from '../values/evaluateByParameterNumber';
import GPURendererChildren from '../rendering/gpu/GPURendererChildren';
import type { GPUParticleBufferState, GPUParticleRenderBufferState } from '../simulation/gpu/Particle';
import type { Node, WebGPURenderer } from 'three/webgpu';
import { bitAnd, float, uint, uniform } from 'three/tsl';
import { GPUDynamicParameterStore } from '../values/GPUDynamicParameterStore';
import type { GPUParticleReadbackField } from '../simulation/gpu/GPUSelectiveReadbackState';

export enum CompensationMode {
  None = 'none',
  Size = 'size',
  Children = 'children',
}

export interface RendererChildrenOptions {
  /** Additional visual copies. Counts are floored and clamped to nonnegative integers. */
  count?: DynamicUntimedValue<number>;
  radius?: DynamicValue<number>;
  /** Radial local XYZ Euler offset in radians, composed after the inherited orientation. Constants stay fixed. */
  rotation?: ValueByParameter<Vector3Input>;
  /** Radial multiplier; numeric values are constant. */
  scale?: ValueByParameter<number>;
  /** Radial multiplier; numeric values are constant. */
  alpha?: ValueByParameter<number>;
  /** Perturbs the radial rotation parameter before radialFalloff, independently of scale and alpha. Default: zero. */
  randomizeRotation?: number;
  randomizeScale?: number;
  randomizeAlpha?: number;
  radialFalloff?: (parameter: number) => number;
}

/** CPU predicate with an optional GPU equivalent, used by reusable selection helpers. */
export type RendererCondition = ParticleCondition & {
  gpu?: ParticleGPUCondition;
  /** Optional metadata refresh for CPU consumers of an already compacted GPU snapshot. */
  prepareReadback?: (particles: Particle[], system: ParticleSystem) => Promise<void>;
};

export interface RendererOptions extends EventReceiverOptions {
  /** Filters sources before grouping/children/work; existing persistent output keeps its own lifetime. */
  condition?: RendererCondition;
  /** TSL equivalent of condition, following Module.conditionGPU conventions. */
  conditionGPU?: ParticleGPUCondition;
  materialComposite?: MaterialCompositeCallback;
  materialCompositeGPU?: MaterialCompositeGPUCallback;
  /** Desired representative cap. Negative or Infinity means unlimited. Defaults to -1. */
  count: number;
  /** Representative fraction, rounded with Math.round after applying count. Defaults to 1. */
  ratio: number;
  /** Maximum world-space assignment distance. Negative means unbounded (default -1). */
  groupingRadius: number;
  /** Optional surface whose appearance multiplies this renderer's configured appearance. */
  materialTarget?: MaterialTarget;
  materialCopySampleMode?: MaterialCopySampleMode;
  /** Copied texture resolution multiplier before the atlas cap, in (0, 1]. Default 1. */
  textureCopyQuality?: number;
  /** Creation options shared by texture-choice, batched-mesh, and copied-material atlases. */
  atlasOptions?: TextureAtlasOptions;
  /** Filters the simulated population by tag before rendering. */
  tags: StrictMultiple<Tag>;
  /** Artistic render-only copies, generated before LOD children. */
  children: RendererChildrenOptions;
  /** Enables artistic and LOD child generation. Defaults to true. */
  generateChildren: boolean;
  /** Visual approximation for population removed by system LOD. Defaults to none. */
  compensation: CompensationMode;
}

/** Base renderer that filters particles and applies renderer LOD before delegating to a backend-compatible view. */
export default abstract class Renderer extends EventReceiver {
  materialTarget?: MaterialTarget;
  materialCopySampleMode: MaterialCopySampleMode;
  readonly textureCopyQuality: number;
  readonly atlasOptions: TextureAtlasOptions;
  protected appearance?: Appearance;
  private _materialCopyRequested = false;
  private _materialComposite?: MaterialCompositeCallback;
  private _materialCompositeGPU?: MaterialCompositeGPUCallback;
  private _appearanceDirty = false;
  private _appearanceBackend?: 'webgl' | 'webgpu';
  get materialComposite(): MaterialCompositeCallback | undefined {
    return this._materialComposite;
  }
  set materialComposite(value: MaterialCompositeCallback | undefined) {
    this._materialComposite = value;
    this._appearanceDirty = true;
    this.needsUpdate = true;
  }
  get materialCompositeGPU(): MaterialCompositeGPUCallback | undefined {
    return this._materialCompositeGPU;
  }
  set materialCompositeGPU(value: MaterialCompositeGPUCallback | undefined) {
    this._materialCompositeGPU = value;
    this._appearanceDirty = true;
    this.needsUpdate = true;
  }
  protected get materialCopyCacheKey(): string {
    return this.appearance?.cacheKey ?? `${this.version}`;
  }

  private readonly _preparedMaterialTextures = new WeakMap<
    NonNullable<ParticleSystem['sceneRenderer']>,
    WeakSet<Texture>
  >();

  /** Upload ready material images during normal preparation, before a deferred variant is first drawn. */
  protected prepareMaterialTextures(system: ParticleSystem, materials: readonly Material[]): void {
    const renderer = system.sceneRenderer;
    if (!renderer) return;

    let prepared = this._preparedMaterialTextures.get(renderer);
    if (!prepared) {
      prepared = new WeakSet();
      this._preparedMaterialTextures.set(renderer, prepared);
    }

    // Render targets belong to their producers; pending images can be retried on a later update.
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (!(value instanceof Texture) || value.isRenderTargetTexture || prepared.has(value)) continue;

        const image = value.image as { width?: number; height?: number } | undefined;
        if (!image?.width || !image.height) continue;

        renderer.initTexture(value);
        prepared.add(value);
      }
    }
  }

  /** Shared source/palette and shader invalidation for material-capable subclasses. */
  protected prepareAppearance(system: ParticleSystem): void {
    if (!this.supportsMaterialCopy) return;

    if (
      this.materialTarget ||
      this._materialComposite ||
      this._materialCompositeGPU ||
      this._materialCopyRequested ||
      system.hasMaterialCopySources
    ) {
      this.enableMaterialCopy(system.materialCopyRegistry, system.sceneRenderer);
    }
    if (this._appearanceDirty && this.appearance) {
      this.onMaterialCopyChange();
      this._appearanceDirty = false;
    }
    this.appearance?.sync(this.materialTarget, this.materialCopySampleMode, system.sceneRenderer);
  }

  /** @internal Enables copying within the owning system registry without adding GPU storage bindings. */
  public enableMaterialCopy(registry?: MaterialCopyRegistry, renderer?: ParticleSystem['sceneRenderer']): void {
    if (!this.supportsMaterialCopy) return;
    this._materialCopyRequested = true;
    if (renderer) {
      const backend = 'isWebGPURenderer' in renderer ? 'webgpu' : 'webgl';
      if (backend !== this._appearanceBackend) this._appearanceDirty = true;
      this._appearanceBackend = backend;
    }
    if (!registry || this.appearance?.registry === registry) return;

    this.appearance?.dispose();
    this.appearance = new Appearance(
      registry,
      () => ({
        materialComposite: this._appearanceBackend === 'webgl' ? this.materialComposite : undefined,
        materialCompositeGPU: this._appearanceBackend === 'webgpu' ? this.materialCompositeGPU : undefined,
        version: this.version,
      }),
      this.atlasOptions,
      this.textureCopyQuality,
    );
    this.onMaterialCopyChange();
    this.needsUpdate = true;
  }

  /** Renderer-specific translation retains the destination shader and rendering settings. */
  public copyMaterial(source: MaterialTarget | undefined): this {
    this.materialTarget = source;
    if (source) this.enableMaterialCopy();
    return this;
  }

  /** Custom renderer subclasses opt in by implementing onMaterialCopyChange. */
  get supportsMaterialCopy(): boolean {
    return this.onMaterialCopyChange !== Renderer.prototype.onMaterialCopyChange;
  }

  protected onMaterialCopyChange(): void {}

  protected disposeMaterialCopy(): void {
    this.appearance?.dispose();
    this.appearance = undefined;
  }

  /** @internal Tags referenced by renderer resource choices, separate from the renderer's tag filter. */
  get selectionTags(): readonly Tag[] {
    return [];
  }

  tags?: Tag[];
  protected _groupCount: number;
  ratio: number;
  groupingRadius: number;
  get count(): number {
    return this._groupCount;
  }
  set count(value: number) {
    this._groupCount = value;
  }
  /** Event-oriented renderers retain their existing ratio selection policy. */
  protected get groupingRatio(): number {
    return this.ratio;
  }
  private _gpuGrouping?: GPURendererGrouping;
  condition?: RendererCondition;
  conditionGPU?: ParticleGPUCondition;
  private readonly _gpuSelection = new GPURendererSelection();
  private _lastCondition?: RendererCondition;
  private _lastConditionGPU?: ParticleGPUCondition;
  private _selectionReadback = false;
  private _approvedParticles?: ReadonlySet<Particle>;
  children: RendererChildrenOptions;
  generateChildren: boolean;
  compensation: CompensationMode;
  private readonly _gpuQuality = uniform(1, 'float');
  private readonly _gpuChildren = new GPURendererChildren();
  private _gpuReadbackPending = false;
  private _gpuReadbackSequence = 0;
  private _version = 0;
  private _gpuConfigurationSignature = '';
  private _gpuParameterVersion = 0;
  private _renderedChildCount = 0;
  private _visibleInstanceCount = 0;
  /** Current renderer population, including generated children; GPU counts use available render-output state. */
  get visibleInstanceCount(): number { return this._visibleInstanceCount; }
  private readonly childOrientation = new Quaternion();
  private readonly childOffsetOrientation = new Quaternion();
  private readonly childEuler = new Euler();
  private _usesGPUChildren = false;
  protected readonly evaluateDynamicGPU = new GPUDynamicParameterStore();
  /** @deprecated Use evaluateDynamicGPU; retained for existing component subclasses. */
  protected get gpuParameters(): GPUDynamicParameterStore {
    return this.evaluateDynamicGPU;
  }

  /** Additional visual particles; GPU diagnostics refresh asynchronously when requested. */
  get renderedChildCount(): number {
    return this._usesGPUChildren ? this._gpuChildren.childCount : this._renderedChildCount;
  }

  /** Field renderers implement copies without expanding the particle view. */
  protected get usesParticleChildren(): boolean { return true; }

  get version(): number {
    return this._version;
  }

  get gpuParameterUploadCount(): number {
    return this.evaluateDynamicGPU.uploadCount;
  }

  set needsUpdate(value: boolean) {
    if (value) {
      this._version += 1;
      if (this._materialComposite || this._materialCompositeGPU) this._appearanceDirty = true;
      this.onGPUConfigurationChange();
    }
  }

  /** Configures particle filtering, artistic children, and LOD compensation. */
  constructor(options: Partial<RendererOptions> = {}) {
    super(options);
    this.benchmarks.register('visibleInstances',
      { type: BenchmarkMetricType.Gauge, unit: 'count', get: () => this.visibleInstanceCount });
    this.benchmarks.register('childrenCount', {
      type: BenchmarkMetricType.Gauge, unit: 'count', get: () => this.renderedChildCount,
    });
    this._materialComposite = options.materialComposite;
    this._materialCompositeGPU = options.materialCompositeGPU;
    this._groupCount = options.count ?? -1;
    this.ratio = options.ratio ?? 1;
    this.groupingRadius = options.groupingRadius ?? -1;
    const capacity = options.atlasOptions?.minCapacity ?? 0;
    if (!Number.isFinite(capacity) || capacity < 0) {
      throw new RangeError('atlasOptions.minCapacity must be a nonnegative finite number.');
    }
    const quality = options.textureCopyQuality ?? 1;
    if (!Number.isFinite(quality) || quality <= 0 || quality > 1) {
      throw new RangeError('textureCopyQuality must be greater than 0 and at most 1.');
    }
    this.textureCopyQuality = quality;
    this.atlasOptions = { ...options.atlasOptions };
    this.materialTarget = options.materialTarget;
    this.materialCopySampleMode = options.materialCopySampleMode ?? MaterialCopySampleMode.UVPatch;
    this.tags = acceptMultiple(options.tags);
    this.condition = options.condition;
    this.conditionGPU = options.conditionGPU;
    this.children = options.children ?? {};
    this.generateChildren = options.generateChildren ?? true;
    this.compensation = options.compensation ?? CompensationMode.None;
  }

  // Runs once, when the renderer is added to the system
  /** Creates rendering resources when attached to a system. */
  public abstract setup(system: ParticleSystem): void;

  /** Prepare optional rendering pipelines without advancing particle or simulation state. */
  public async prepareResources(_system: ParticleSystem, _renderer: WebGPURenderer): Promise<void> {
    // Most renderers have no preparation work independent of their particle buffers.
    void _system;
    void _renderer;
  }

  protected abstract _update(particles: Particle[], system: ParticleSystem, deltaTime: number): void;

  /** @internal CPU-readback renderers consume their batch when the CPU preprocessing actually executes. */
  get supportsGPUEventInput(): boolean {
    return this.supportsGPUInput && !this.updateGPUUsesCPUReadback;
  }

  /** Whether this renderer can consume GPU particle buffers without a selective CPU readback. */
  get supportsGPUInput(): boolean {
    return this._updateGPU !== Renderer.prototype._updateGPU;
  }

  /** Synchronizes runtime values and invalidates structural GPU changes. */
  public syncGPUConfiguration(): void {
    if (this.condition !== this._lastCondition || this.conditionGPU !== this._lastConditionGPU) {
      this._lastCondition = this.condition; this._lastConditionGPU = this.conditionGPU;
      this.needsUpdate = true;
    }
    this.evaluateDynamicGPU.sync();
    if (this.evaluateDynamicGPU.version !== this._gpuParameterVersion) {
      this._gpuParameterVersion = this.evaluateDynamicGPU.version;
      this._version += 1;
      this.onGPUConfigurationChange();
    }

    const signature = [
      this.tags?.join('|') ?? '',
      this.compensation,
      this.generateChildren,
      this._groupCount,
      this.groupingRatio,
      this.groupingRadius,
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

  protected onGPUConfigurationChange(): void {}

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
  public update(particles: Particle[], system: ParticleSystem, deltaTime: number = 0): void {
    const end = this.benchmarks.begin('update');
    try { this.updatePopulation(particles, system, deltaTime); } finally { end?.(); }
  }

  private updatePopulation(particles: Particle[], system: ParticleSystem, deltaTime: number = 0): void {
    this.prepareAppearance(system);

    this.beginExecution(system, deltaTime);
    this._usesGPUChildren = false;
    const eligible =
      system.quality === 0
        ? []
        : particles.filter(particle => particle.alive
          && (!this.tags || tagsIntersect(this.tags, particle.tags ?? []))
          && (this._selectionReadback || !this.condition
            || this.condition(particle, deltaTime, this.executionContext!)));
    this.preparePopulation(eligible.length);
    const visible = groupRendererParticles(eligible, this._groupCount, this.groupingRatio, this.groupingRadius, system);
    this.updateView(visible, particles, system, deltaTime);
  }

  /** Resource reservation hook; count refers to the eligible simulation population. */
  protected preparePopulation(count: number): void {
    void count;
  }

  private updateView(visible: Particle[], particles: Particle[], system: ParticleSystem, deltaTime: number): void {
    const originalCount = visible.length;
    const childCounts: number[] = [];

    // Add artistic renderer children to the simulated population.
    for (let i = 0; this.generateChildren && this.usesParticleChildren && i < originalCount; i++) {
      const parent = visible[i];
      const value = evaluateDynamicNumber(this.children.count ?? 0, 0, `${parent.id}:count`);
      const count = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
      childCounts[i] = count;
      for (let child = 0; child < count; child++) {
        visible.push(
          this.generateChild(
            parent,
            child,
            Math.max(0, evaluateDynamicNumber(this.children.radius, parent.time, `${parent.id}:${child}`) ?? 0),
            true,
          ),
        );
      }
    }

    // Compensate for LOD after artistic children, preserving their scale and alpha.
    if (this.generateChildren && this.usesParticleChildren && this.compensation === CompensationMode.Children
      && system.quality > 0 && system.quality < 1) {
      const additional = 1 / system.quality - 1;
      const full = Math.floor(additional);
      const population = visible.length;
      for (let i = 0; i < population; i++) {
        const parent = visible[i];
        const firstChild = childCounts[i] ?? 0;
        const selected = seedrandom.tychei(`${parent.id}[${firstChild + full}]`).quick() < additional - full;
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

    this._visibleInstanceCount = visible.length;
    this._renderedChildCount = visible.length - originalCount;
    this._approvedParticles = this.condition ? new Set(visible) : undefined;
    try { this._update(visible, system, deltaTime); } finally { this._approvedParticles = undefined; }
  }

  /** Expansion inherits the source decision; event-triggered sources are checked before their own work. */
  protected conditionAllows(particle: Particle, system: ParticleSystem, deltaTime: number): boolean {
    return this._approvedParticles?.has(particle) === true || !this.condition
      || this.condition(particle, deltaTime, { system, deltaTime, events: this.executionContext?.events ?? [] });
  }

  private generateChild(parent: Particle, ordinal: number, radius: number, applyDistanceScaling: boolean): Particle {
    const child = parent.shallowClone(`${parent.id}[${ordinal}]`, { position: new Vector3() });
    child.parent = parent;

    const random = seedrandom.tychei(child.id);
    const distance = Math.cbrt(random.quick());
    child.position
      .setFromSphericalCoords(distance * radius, Math.acos(2 * random.quick() - 1), random.quick() * Math.PI * 2)
      .add(parent.position);

    if (applyDistanceScaling) {
      const options = this.children;

      // Fixed draws keep all three properties independent of which options are enabled.
      const scaleVariation = random.quick() - 0.5;
      const alphaVariation = random.quick() - 0.5;
      const rotationVariation = random.quick() - 0.5;
      const parameter = (amount: number, variation: number) => {
        let t = MathUtils.clamp((radius > 0 ? distance : 0) + amount * variation, 0, 1);
        if (options.radialFalloff) t = options.radialFalloff(t);
        return t;
      };
      if (options.rotation !== undefined) {
        const rotation = options.rotation;
        const offset = evaluateByParameterVector3(
          typeof rotation === 'number' || rotation instanceof Vector3 ? [rotation, rotation] : rotation,
          parameter(options.randomizeRotation ?? 0, rotationVariation),
        );
        this.childOrientation.setFromEuler(this.childEuler.setFromVector3(parent.rotation));
        this.childOffsetOrientation.setFromEuler(this.childEuler.setFromVector3(offset));
        this.childOrientation.multiply(this.childOffsetOrientation);
        child.rotation = new Vector3().setFromEuler(this.childEuler.setFromQuaternion(this.childOrientation));
      }
      const multiplier = (value: ValueByParameter<number> | undefined, amount: number, variation: number) =>
        typeof value === 'number' || value === undefined
          ? (value ?? 1) : evaluateByParameterNumber(value, parameter(amount, variation));
      const scale = multiplier(options.scale, options.randomizeScale ?? 0, scaleVariation);
      if (scale !== 1) child.scale = parent.scale.clone().multiplyScalar(scale);
      child.alpha *= multiplier(options.alpha, options.randomizeAlpha ?? 0, alphaVariation);
    }

    return child;
  }

  /** Base-class GPU preprocessing; subclasses consume the resulting ordinary render view. */
  public updateGPU(
    buffers: GPUParticleBufferState | GPUParticleRenderBufferState,
    system: ParticleSystem,
    deltaTime: number = 0,
  ): void {
    const end = this.benchmarks.begin('submissionTime');
    try { this.updatePopulationGPU(buffers, system, deltaTime); } finally { end?.(); }
  }

  private updatePopulationGPU(
    buffers: GPUParticleBufferState | GPUParticleRenderBufferState,
    system: ParticleSystem,
    deltaTime: number = 0,
  ): void {
    this.prepareAppearance(system);
    let selectedBuffers = buffers;

    if (!this.supportsGPUInput) throw new Error('This particle renderer does not support GPU particle buffers.');
    if (!this.updateGPUUsesCPUReadback) {
      this.beginExecution(system, deltaTime);
      this.beginGPUExecution(system);
    }
    const conditionGPU = this.conditionGPU ?? this.condition?.gpu;
    if (this.condition && !conditionGPU && !this.updateGPUUsesCPUReadback) {
      throw new Error('GPU renderers require conditionGPU (or condition.gpu) for custom particle conditions.');
    }
    if (this.updateGPUUsesCPUReadback && this.condition && !conditionGPU) {
      // A CPU-only predicate must run before CPU grouping, never after GPU representatives were chosen.
      this._updateGPU(buffers, system, deltaTime);
      return;
    }
    if (conditionGPU) {
      if (this.updateGPUUsesCPUReadback && this._gpuReadbackPending) {
        // Freeze the compact snapshot until its small readback completes; persistent outputs still age.
        this._updateGPU(buffers, system, deltaTime);
        return;
      }
      const selected = this._gpuSelection.prepare(buffers, system, conditionGPU, this.version,
        system.getGPURendererTagMask(this.tags), this.updateGPUUsesCPUReadback, deltaTime);
      if (this.updateGPUUsesCPUReadback) {
        // Persistent renderers still tick their own lifetimes while the compact source snapshot arrives.
        this._updateGPU(selected, system, deltaTime);
        return;
      }
      selectedBuffers = selected;
    }
    this._usesGPUChildren = this.generateChildren && this.usesParticleChildren && !this.updateGPUUsesCPUReadback;
    this._renderedChildCount = 0;
    // A non-reducing policy cannot benefit from grouping, including when only a
    // subset of GPU slots is eligible. Do not even construct the spatial helper.
    const needsGrouping = rendererGroupCount(selectedBuffers.count, this._groupCount, this.groupingRatio)
      < selectedBuffers.count;
    const grouping = needsGrouping ? (this._gpuGrouping ??= new GPURendererGrouping()) : undefined;
    const tagMask = system.getGPURendererTagMask(this.tags);
    const grouped =
      grouping?.prepare(selectedBuffers, system, this._groupCount, this.groupingRatio, this.groupingRadius, tagMask)
      ?? selectedBuffers;
    if (grouped !== selectedBuffers && this.updateGPUUsesCPUReadback) {
      this._usesGPUChildren = false;
      if (!this._gpuReadbackPending) {
        const sequence = ++this._gpuReadbackSequence;
        this._gpuReadbackPending = true;
        void grouping!
          .readback()
          .then(particles => {
            if (sequence !== this._gpuReadbackSequence || system.paused) return;
            this.preparePopulation(grouping!.eligibleCount);
            this.updateView(particles, particles, system, deltaTime);
          })
          .finally(() => {
            if (sequence === this._gpuReadbackSequence) this._gpuReadbackPending = false;
          });
      }
      return;
    }
    // Readback implementations expand once through the CPU update entry point.
    const visual = this._usesGPUChildren
      ? this._gpuChildren.prepare(grouped, system, this.children, this.compensation, this.version, tagMask)
      : grouped;
    this._visibleInstanceCount = visual.count;
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
    const selected = Boolean(this.conditionGPU ?? this.condition?.gpu);
    const readback = selected
      ? this._gpuSelection.readback().then(particles => particles.map(particle => ({ valid: true, particle })))
      : system.selectiveReadback(Math.min(buffers.count, limit), fields);
    void readback
      .then(async results => {
        if (sequence !== this._gpuReadbackSequence || system.paused) return;
        const particles = results.filter(result => result.valid).map(result => result.particle);
        await this.prepareReadbackParticles(particles, system, selected);
        if (sequence !== this._gpuReadbackSequence || system.paused) return;
        this._selectionReadback = selected;
        try { this.update(particles, system, deltaTime); } finally { this._selectionReadback = false; }
      })
      .finally(() => {
        if (sequence === this._gpuReadbackSequence) this._gpuReadbackPending = false;
      });
  }

  /** Prepare optional compact source metadata before renderer-specific CPU processing. */
  protected async prepareReadbackParticles(
    particles: Particle[], system: ParticleSystem, selected: boolean,
  ): Promise<void> {
    if (selected) await this.condition?.prepareReadback?.(particles, system);
  }

  /** Refresh a CPU/readback renderer from its displayed state, without requesting new particles. */
  public refresh(system: ParticleSystem): void {
    void system;
    this.cancelGPUSelectiveReadback();
  }

  protected cancelGPUSelectiveReadback(): void {
    this._gpuReadbackSequence += 1;
    this._gpuReadbackPending = false;
  }

  /** Restores transient backend state while retaining reusable rendering resources. */
  public reset(): void {
    this._renderedChildCount = 0;
    this._visibleInstanceCount = 0;
    this._usesGPUChildren = false;
    this.cancelGPUSelectiveReadback();
    this._gpuChildren.reset();
    this._gpuSelection.reset();
    this._gpuGrouping?.reset();
    this._gpuGrouping = undefined;
  }

  // Cleanup
  /** Permanently releases owned rendering resources. */
  public abstract destroy(): void;
  /** Removes displayed particles while retaining resources for reuse. */
  public abstract clear(): void;
}
