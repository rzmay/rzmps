import { GasModuleStage } from '../enums/GasModuleStage';
import type * as THREE from 'three';
import type Particle from '../core/Particle';
import type { GPUGasSourceParticle } from '../simulation/gpu/GasSourceData';
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

/** Specific source emission: temperature/color/velocity are not density-premultiplied. */
export interface GasEmission {
  density: number;
  temperature: number;
  color: THREE.Color;
  velocity: THREE.Vector3;
}

export interface GPUGasEmission {
  density: Node<'float'>;
  temperature: Node<'float'>;
  color: Node<'vec3'>;
  velocity: Node<'vec3'>;
}

/** Lazy view over the current cell's contributing source particles; each iteration repeats the sparse query. */
export interface GPUGasParticles {
  readonly length: Node<'float'>;
  forEach(callback: (particle: GPUGasSourceParticle, contribution: Node<'float'>) => void): void;
}

export interface GasInitializationContext {
  readonly module: GasModule;
  readonly index: THREE.Vector3;
  readonly position: THREE.Vector3;
  readonly deltaTime: number;
  readonly elapsedTime: number;
}

export type GPUGasInitializationContext = Pick<GasModuleContext,
  'module' | 'index' | 'grid' | 'deltaTime' | 'elapsedTime'> & { readonly position: Node<'vec3'> };
export type GasInitializer = (particles: readonly Particle[], emission: GasEmission,
  context: GasInitializationContext) => void;
export type GPUGasInitializer = (particles: GPUGasParticles, emission: GPUGasEmission,
  context: GPUGasInitializationContext) => void;

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
  /** World units squared per second. Custom increases must respect dt <= cellWidth² / (6 * diffusivity). */
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

export interface GasModuleOptions extends Partial<Pick<ModuleOptions, 'priority' | 'tags' | 'events' | 'eventScope'>> {
  /** Disables all gas callbacks when false. Defaults to true. */
  enabled?: boolean;
  /** CPU/reference source-deposition callback. Mutates specific emission state in priority order. */
  initialize?: GasInitializer;
  /** GPU counterpart using TSL assignment and lazy sparse source iteration. No particle readback. */
  initializeGPU?: GPUGasInitializer;
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
  private readonly graphStates = new Map<GasModuleStage, { values: readonly unknown[]; revision: number }>();
  readonly options: GasModuleOptions;
  enabled: boolean;

  /** Gas callbacks never participate in the ordinary particle modifier pipeline. */
  override get modifiesParticles(): boolean {
    return false;
  }

  constructor(options: GasModuleOptions = {}) {
    super(() => {}, { ...options, modifyGPU: () => {} });
    this.options = options;
    this.enabled = options.enabled ?? true;
  }

  get initialize(): GasInitializer | undefined { return this.options.initialize; }
  set initialize(value: GasInitializer | undefined) { this.options.initialize = value; }
  get initializeGPU(): GPUGasInitializer | undefined { return this.options.initializeGPU; }
  set initializeGPU(value: GPUGasInitializer | undefined) { this.options.initializeGPU = value; }

  /** Reference/CPU evaluation uses the same enabled/priority semantics without creating a CPU gas solver. */
  static initializeEmission(modules: readonly GasModule[], particles: readonly Particle[], emission: GasEmission,
    context: Omit<GasInitializationContext, 'module'>): void {
    for (const module of [...modules].filter(module => module.enabled).sort((a, b) => a.priority - b.priority)) {
      module.initialize?.(particles, emission, { ...context, module });
    }
  }

  /** Simulation callback, separate from the base class's per-particle modifyGPU hook. */
  get modifyGasGPU(): GasModuleUpdate | undefined {
    return this.options.modifyGPU;
  }
  set modifyGasGPU(value: GasModuleUpdate | undefined) {
    this.options.modifyGPU = value;
  }

  get modifyRenderGPU(): GasRenderModuleUpdate | undefined {
    return this.options.modifyRenderGPU;
  }
  set modifyRenderGPU(value: GasRenderModuleUpdate | undefined) {
    this.options.modifyRenderGPU = value;
  }

  /** Callback/dependency structure is tracked per gas stage rather than as particle options. */
  override syncGPUConfiguration(): void {
    this.evaluateDynamicGPU.sync();
  }

  /** @internal Stable stage-local cache identity; uniforms remain ordinary captured TSL uniforms. */
  graphKey(stage: GasModuleStage | keyof typeof GasModuleStage): string {
    const resolved = GasModuleStage[stage];
    if (!resolved) throw new RangeError('Unknown gas module stage.');

    this.syncGPUConfiguration();
    const deps = typeof this.options.deps === 'function' ? this.options.deps() : (this.options.deps ?? []);
    const values = [
      resolved === GasModuleStage.Initialization ? this.initializeGPU
        : resolved === GasModuleStage.Simulation ? this.modifyGasGPU : this.modifyRenderGPU,
      resolved === GasModuleStage.Initialization ? this.initialize : undefined,
      this.version,
      this.evaluateDynamicGPU.version,
      this.priority,
      ...deps,
    ];
    const previous = this.graphStates.get(resolved);
    if (
      !previous ||
      values.length !== previous.values.length ||
      values.some((v, i) => !Object.is(v, previous.values[i]))
    ) {
      this.graphStates.set(resolved, { values, revision: (previous?.revision ?? 0) + 1 });
    }
    return `${this.gasId}:${this.graphStates.get(resolved)!.revision}`;
  }

  /** @internal Reuses normal discovery, dependent flattening, tag matching and stable priority ordering. */
  static collect(
    system: ParticleSystem,
    tags: Tag[] | undefined,
    stage: GasModuleStage | keyof typeof GasModuleStage,
  ): GasModule[] {
    const resolved = GasModuleStage[stage];
    if (!resolved) throw new RangeError('Unknown gas module stage.');

    return system
      .getModules(GasModule, tags)
      .filter(
        module =>
          module.enabled && (resolved === GasModuleStage.Initialization ? module.initialize || module.initializeGPU
            : resolved === GasModuleStage.Simulation ? module.modifyGasGPU : module.modifyRenderGPU),
      )
      .sort((a, b) => a.priority - b.priority);
  }
}
