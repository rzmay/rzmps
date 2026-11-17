import type { Node } from 'three/webgpu';
import Module, { type ModuleOptions } from '../core/Module';
import type ParticleSystem from '../core/ParticleSystem';
import type { Tag } from '../types/tag.types';

/** Shader-local gas state. Temperature and color are specific, not density-premultiplied. */
export interface GPUGasCell {
  readonly position: Node<'vec3'>;
  density: Node<'float'>;
  temperature: Node<'float'>;
  velocity: Node<'vec3'>;
  color: Node<'vec3'>;
}

/** Read-only logical-cell access to the input snapshot of the current solver stage. GPU only. */
export interface GasGridQuery {
  /** Missing/nonresident/out-of-range cells return zero state. Never writes neighbor storage. */
  getCell(x: Node, y: Node, z: Node): Readonly<GPUGasCell>;
}

/** Local solver coefficients, initialized after the simulation's by-parameter controls. */
export interface GasModuleContext {
  /** Logical gas-cell coordinate, independent of resident page/texture packing. */
  readonly index: Node<'ivec3'>;
  /** All fused modules query the same input snapshot, even after earlier local edits. */
  readonly grid: GasGridQuery;
  readonly module: GasModule;
  readonly deltaTime: Node<'float'>;
  readonly elapsedTime: Node<'float'>;
  turbulenceNoiseStrength: Node<'float'>;
  turbulenceNoiseFrequency: Node<'float'>;
  vorticityStrength: Node<'float'>;
  buoyancy: Node<'float'>;
  densityDissipation: Node<'float'>;
  temperatureDissipation: Node<'float'>;
  colorDissipation: Node<'float'>;
  velocityDissipation: Node<'float'>;
  scalarDiffusion: Node<'float'>;
}

/** Transient ray-sample properties; changing them never writes back to the simulation. */
export interface GasRenderModuleContext {
  readonly module: GasModule;
  readonly elapsedTime: Node<'float'>;
  density: Node<'float'>;
  color: Node<'vec3'>;
  opacity: Node<'float'>;
  emission: Node<'vec3'>;
  /** Effective self-lit fraction in [0, 1]; clamped again after custom edits. Does not illuminate other samples. */
  emissive: Node<'float'>;
  densityNoiseStrength: Node<'float'>;
  densityNoiseContrast: Node<'float'>;
  densityNoiseFrequency: Node<'float'>;
}

export type GasModuleUpdate = (cell: GPUGasCell, context: GasModuleContext) => void;
export type GasRenderModuleUpdate = (cell: GPUGasCell, context: GasRenderModuleContext) => void;
type Stage = 'simulation' | 'render';

export interface GasModuleOptions extends Partial<Pick<ModuleOptions, 'priority' | 'tags' | 'events' | 'eventScope'>> {
  /** Disables both gas callbacks when false. Defaults to true. */
  enabled?: boolean;
  /** GPU solver callback. Mutate nodes with assign/addAssign/mulAssign, not JavaScript assignment. */
  modifyGPU?: GasModuleUpdate;
  /** GPU ray-sample callback. All changes are transient. Native WebGPU only. */
  modifyRenderGPU?: GasRenderModuleUpdate;
  /** Captured configuration dependencies; replace entries or set needsUpdate after changing captured objects. */
  deps?: readonly unknown[] | (() => readonly unknown[]);
}

/** GPU gas-cell counterpart of Module, discovered by GasSimulation and VolumeRenderer. */
export default class GasModule extends Module {
  private static nextId = 0;
  private readonly gasId = GasModule.nextId++;
  private readonly graphStates = new Map<Stage, { values: readonly unknown[]; revision: number }>();
  readonly options: GasModuleOptions;
  enabled: boolean;

  /** Gas callbacks never participate in the ordinary particle modifier pipeline. */
  override get modifiesParticles(): boolean { return false; }

  constructor(options: GasModuleOptions = {}) {
    super(() => {}, { ...options, modifyGPU: () => {} });
    this.options = options;
    this.enabled = options.enabled ?? true;
  }

  /** Simulation callback, separate from the base class's per-particle modifyGPU hook. */
  get modifyGasGPU(): GasModuleUpdate | undefined { return this.options.modifyGPU; }
  set modifyGasGPU(value: GasModuleUpdate | undefined) { this.options.modifyGPU = value; }

  get modifyRenderGPU(): GasRenderModuleUpdate | undefined { return this.options.modifyRenderGPU; }
  set modifyRenderGPU(value: GasRenderModuleUpdate | undefined) { this.options.modifyRenderGPU = value; }

  /** Callback/dependency structure is tracked per gas stage rather than as particle options. */
  override syncGPUConfiguration(): void {
    this.evaluateDynamicGPU.sync();
  }

  /** @internal Stable stage-local cache identity; uniforms remain ordinary captured TSL uniforms. */
  graphKey(stage: Stage): string {
    this.syncGPUConfiguration();
    const deps = typeof this.options.deps === 'function' ? this.options.deps() : this.options.deps ?? [];
    const values = [stage === 'simulation' ? this.modifyGasGPU : this.modifyRenderGPU,
      this.version, this.evaluateDynamicGPU.version, this.priority, ...deps];
    const previous = this.graphStates.get(stage);
    if (!previous || values.length !== previous.values.length
      || values.some((v, i) => !Object.is(v, previous.values[i]))) {
      this.graphStates.set(stage, { values, revision: (previous?.revision ?? 0) + 1 });
    }
    return `${this.gasId}:${this.graphStates.get(stage)!.revision}`;
  }

  /** @internal Reuses normal discovery, dependent flattening, tag matching and stable priority ordering. */
  static collect(system: ParticleSystem, tags: Tag[] | undefined, stage: Stage): GasModule[] {
    return system.getModules(GasModule, tags).filter(module => module.enabled
      && (stage === 'simulation' ? module.modifyGasGPU : module.modifyRenderGPU))
      .sort((a, b) => a.priority - b.priority);
  }
}
