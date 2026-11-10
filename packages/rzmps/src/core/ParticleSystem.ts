import GlobalSettings from './GlobalSettings';
import * as THREE from 'three';
import { If, uint } from 'three/tsl';
import { WebGPURenderer, type Node } from 'three/webgpu';
import type { CollisionHit } from '../collision/collision.types';
import EmissionRuntime from '../emission/EmissionRuntime';
import EmissionSource, { type EmissionSourceData, type SubSystemSource } from '../emission/EmissionSource';
import Emitter, { type EmissionContext } from '../emission/Emitter';
import type { GPUEmissionSupportReport } from '../emission/gpu/Emission';
import overrideEmitterOptions from '../emission/options.utils';
import { EndBehavior } from '../enums/EndBehavior';
import { MaxCulling } from '../enums/MaxCulling';
import { SimulationSpace } from '../enums/SimulationSpace';
import EventReceiver, { type EventScope, type SimulationEvent } from '../events/EventReceiver';
import EventRuntime from '../events/EventRuntime';
import { cpuEventHandler, eventNames, type EventSubscriptions } from '../events/events.utils';
import { emptyGPUEvents, SharedGPUEventBatch, type GPUEventBatch } from '../events/gpu/EventBatch';
import { GPUEventBufferState } from '../events/gpu/EventBuffer';
import { isWebGPURenderer } from '../utils/gpu/isWebGPURenderer';
import type { PackedFloatStorage } from '../utils/gpu/storage.utils';
import Collision, { type CollisionListener } from '../modules/Collision';
import { MaterialCopyRegistry } from '../rendering/compositing/MaterialCopyRegistry';
import LiveCubemap, { PARTICLE_RENDERER_OBJECT_KEY, type LiveCubemapOptions } from '../rendering/renderers/LiveCubemap';
import SpriteRenderer from '../rendering/renderers/SpriteRenderer';
import { type GPUAllocationDiagnostics } from '../simulation/gpu/AllocationBuffer';
import {
  resetInitializationAttributesGPU,
  type GPUParticleBufferState,
  type GPUParticleLike,
} from '../simulation/gpu/Particle';
import { type GPUParticleReadbackField, type GPUSelectiveReadbackResult } from '../simulation/gpu/SelectiveReadback';
import { buildGPUSystemSchedule, type GPUSystemSchedule } from '../simulation/gpu/buildGPUSystemSchedule';
import GPUSimulation from '../simulation/GPUSimulation';
import SimulationFrames from '../simulation/SimulationFrames';
import ParticleOctree from '../spatial/structures/ParticleOctree';
import ParticleSpatialGrid, { type ParticleSpatialGridOptions } from '../spatial/structures/ParticleSpatialGrid';
import SpatialEffect from '../spatial/effects/SpatialEffect';
import SpatialRuntime from '../spatial/structures/SpatialRuntime';
import type { Multiple } from '../types/multiple.types';
import type { Tag } from '../types/tag.types';
import acceptMultiple from '../utils/acceptMultiple';
import type { DynamicValue } from '../values/dynamicValue.types';
import evaluateDynamicNumber from '../values/evaluateDynamicNumber';
import maximumDynamicNumber from '../values/maximumDynamicNumber';
import LODHelper, { type LODSettings } from './LODHelper';
import Module from './Module';
import Particle, {
  type GPUParticleInitializationContext,
  type ParticleCachedValues,
  type ParticleInitializationContext,
} from './Particle';
import Renderer from './Renderer';
import tagsIntersect from './tags/tagsIntersect';

/** Construction options; fields can be omitted to use the documented defaults. */
export interface ParticleSystemOptions {
  /** Sources that create particles. Omission creates one default emitter; pass [] for manual particles. */
  emitters: Multiple<Emitter>;
  /** Views of the simulated population. Omission creates a sprite renderer; pass [] for simulation only. */
  renderers: Multiple<Renderer>;
  /** Ordered composition of particle modifiers; numeric priority determines the execution phase. */
  modules: Multiple<Module>;
  /** Explicit generic spatial effects, combined with matching scene effects. */
  spatialEffects: Multiple<SpatialEffect>;
  /** Selects which discovered or explicit spatial effects may affect this system. */
  spatialEffectFilter: (spatialEffect: SpatialEffect) => boolean;
  /** Enables generic spatial-effect processing.
   * @defaultValue true */
  useSpatialEffects: boolean;
  /** Filters built-in bounded effects against conservative system travel bounds. */
  spatialEffectBoundsFiltering: boolean;
  /** Nonnegative multiplier applied to simulation delta seconds.
   * @defaultValue 1 */
  simulationSpeed: number;
  /** Emission cycle length in seconds, independent of particle lifetime.
   * @defaultValue 10 */
  duration: number;
  /** Simulates a cycle before normal playback begins.
   * @defaultValue false */
  prewarm: boolean;
  /** Fixed prewarm steps per second; invalid values fall back to 24.
   * @defaultValue 24 */
  prewarmFPS: number;
  /**
   * Whether to divide large simulation intervals into smaller steps.
   *
   * When enabled (default), elapsed time is simulated in increments of at most
   * substepDeltaTime. Each increment performs normal emission, particle updates,
   * and spatial interactions, improving collisions, forces, emission timing, and
   * other time-dependent behavior after irregular or delayed frames.
   *
   * Substepping is more computationally expensive because multiple simulation
   * updates may occur during one rendered frame. Only the most recent maxCatchup
   * seconds are simulated; null estimates this limit from emitter lifetimes and
   * system duration. An internal step-count safeguard also bounds work.
   *
   * When disabled, the entire elapsed interval is processed in one simulation
   * step. Continuous births still receive distributed spawn times and per-particle
   * deltas, but spatial interactions, collisions, and nonlinear motion may be
   * inaccurate over large intervals. This is faster and may suit simple effects
   * or performance-sensitive applications.
   *
   * Neither mode guarantees exact reconstruction of missed frames.
   * @default true
   */
  substep: boolean;
  /** Maximum simulation step in seconds. Defaults to 1 / prewarmFPS. */
  substepDeltaTime: number;
  /** Maximum simulation seconds recovered per interval; null uses duration and finite emitter lifetimes.
   * @default null */
  maxCatchup: number | null;
  /** Restarts the emission cycle after duration.
   * @defaultValue true */
  looping: boolean;
  /** Controls cleanup after a nonlooping system ends; existing particles may remain.
   * @defaultValue EndBehavior.None */
  endBehavior: EndBehavior | `${EndBehavior}`;
  /** Maximum retained particles; excess particles are culled during simulation. */
  maxParticles: number;
  /** Chooses whether old or newly spawned particles are culled at capacity.
   * @defaultValue MaxCulling.New */
  maxCullingMode: MaxCulling | `${MaxCulling}`;
  /** Camera-distance limit for normal updates; zero disables distance culling.
   * @defaultValue 0 */
  simulationDistance: number;
  /** Distance-based simulated population quality; omission disables LOD. */
  lod: Partial<LODSettings>;
  /** Gravity acceleration vector; supplying it enables gravity unless gravityModifier overrides that choice. */
  gravity: THREE.Vector3;
  /** Particle-age-dependent gravity multiplier; defaults to 1 with explicit gravity, otherwise 0. */
  gravityModifier: DynamicValue<number>;
  /** Multiplier for velocity inherited from movement of the emitter context. */
  inheritVelocity: number;
  /** World, Local, Transform or per-particle Source coordinates; changing modes preserves existing world poses. */
  simulationSpace: SimulationSpace | `${SimulationSpace}`;
  /** Live world-space frame for Transform mode; a Matrix4 is caller-managed. Omission uses identity. */
  simulationSpaceTransform: THREE.Object3D | THREE.Matrix4 | null;
  /** Source mode behavior when an emitting source disappears. Defaults to detach at its last valid frame. */
  sourceLoss: 'detach' | 'kill';
  /** Requests GPU simulation when a WebGPURenderer and compatible components are available. */
  gpuProcessing: boolean;
  /** Enables periodic GPU allocation and dispatch diagnostics. */
  gpuDebug: boolean;
  /** Frames between GPU diagnostic snapshots. */
  gpuDebugInterval: number;

  /** Enables dynamic environment captures; requires renderer/camera context from rendering. */

  useLiveCubemap: boolean;
  /** Dynamic reflection capture options; capture work is separate from simulation. */
  cubemapSettings: Partial<LiveCubemapOptions>;
  /** Legacy shorthand for cubemapSettings.fps. */
  liveCubemapFPS: number;
  /** Legacy shorthand for cubemapSettings.resolutionScale. */
  liveCubemapResolutionScale: number;
  /** Legacy shorthand for cubemapSettings.intensity. */
  liveCubemapIntensity: number;
}

/** Source-system context for a subsystem's GPU eligibility predicate. */
export interface SubSystemGPUContext {
  /** The parent system whose live particle or captured event is being tested. */
  system: ParticleSystem;
  childSystem: ParticleSystem;
  /** Current parent-particle neighborhood, when requested by the predicate. */
  spatialGrid?: ParticleSpatialGrid;
  /** Undefined for continuous emission; captured GPUEventType for event emission. */
  eventType?: Node<'uint'>;
}

/** TSL predicate; optional grid options request a fresh, system-managed parent query grid. */
export type SubSystemGPUCondition = ((
  particle: GPUParticleLike,
  deltaTime: Node<'float'>,
  context: SubSystemGPUContext,
) => Node<'bool'>) & { spatialGridOptions?: Partial<ParticleSpatialGridOptions> };

/** Parent-event emission and inheritance; child systems share their parent simulation clock. */
export interface SubSystemOptions {
  /** Predicate or switch selecting whether a parent particle may trigger child emission. */
  shouldEmit: boolean | ((source: SubSystemSource) => boolean);
  /** GPU counterpart of shouldEmit; false still disables emission on both backends. */
  shouldEmitGPU: SubSystemGPUCondition | null;
  /** Select parent source tags, using the same intersection rule as modules/renderers. */
  tags?: Tag[];
  /** Named events, optionally with CPU and TSL context handlers. */
  onEvent?: EventSubscriptions;
  events?: readonly string[];
  /** Exclusive event origins; an explicit attachment value overrides the emitter scope. */
  eventScope?: EventScope;
  /** Fraction of eligible parent particles selected for subsystem emission. */
  ratio: number;
  /** Emits while a parent particle remains alive, using an independent emission context. */
  emitContinuous: boolean;
  /** Starts child emission from collision events reported by a Collision module. */
  emitOnCollision: boolean;
  /** Starts child emission when a parent particle is born. */
  emitOnSpawn: boolean;
  /** Starts child emission when a parent particle expires. */
  emitOnDeath: boolean;
  /** Blends child scale with the triggering particle scale; zero retains child configuration. */
  inheritScale: number;
  /** Blends child lifetime with the parent lifetime; zero retains independent child timing. */
  inheritLifetime: number;
  /** Blends child color with the triggering particle color. */
  inheritColor: number;
  /** Blends child alpha with the triggering particle alpha. */
  inheritAlpha: number;
  /** Blends child mass with the triggering particle mass. */
  inheritMass: number;
  inheritVelocity: number;

  /** Exponent scaling burst counts and emission rates by contact impulse; zero disables scaling. */
  impulseAffectsCount?: number;
  /** Exponent controlling contact-impulse scaling of child size. */

  impulseAffectsScale: number;
  /** Exponent controlling contact-impulse scaling of child velocity. */
  impulseAffectsSpeed: number;
  /** Exponent controlling contact-impulse scaling of child lifetime. */
  impulseAffectsLifetime: number;
  /** Exponent controlling contact-impulse scaling of child mass. */
  impulseAffectsMass: number;
  /** Aligns child emission with collision impulse direction. */
  impulseAffectsAlignment: boolean;
  /** Minimum contact impulse needed to trigger collision emission. */
  impulseThreshold: number;
}

export type ParticleListener = (particle: Particle) => void;

/** Describes whether every emitter and subsystem can use GPU-native emission. */
export interface ParticleSystemGPUEmissionSupportReport {
  supported: boolean;
  reasons: string[];
  emitters: GPUEmissionSupportReport[];
  subsystems: Array<{
    system: ParticleSystem;
    supported: boolean;
    reasons: string[];
  }>;
}

/** Owns particle simulation and renderer objects; attach to a Three.js scene and update once per frame. */
class ParticleSystem extends THREE.Object3D {
  static readonly Settings = GlobalSettings;

  /** @internal Feature owner; public accessors below preserve the system API. */
  readonly spatialRuntime = new SpatialRuntime();
  /** @internal Event transport owner. */
  readonly eventRuntime = new EventRuntime(
    this,
    () => this._reconcileEventReceivers(),
    event => this._routeEmitterEvent(event),
  );
  /** @internal Emission execution owner. */
  readonly emissionRuntime = new EmissionRuntime(this, {
    deltaTime: () => this.deltaTime,
    discardingTime: () => this._discardingTime,
    clockWrap: () => this._skippedClockWrap,
    playing: () => this._playing,
    nativeEmission: () => this._shouldExecuteEmittersOnGPU(),
    canUpdateAsGPUChild: (parent, options) => this.gpuSimulation._canUpdateAsGPUSubSystem(parent, options),
    eventNames: emitter => this._emitterEventNames(emitter),
    notifySpawn: particle => this._notifySpawn(particle),
    registerProducer: (source, origin) => this.frameRuntime._sourceProducers.set(source, origin),
    activate: now => {
      this._playing = true;
      this._ended = false;
      this.lastFrame = now;
    },
  });
  /** @internal Simulation frame/source attachment owner. */
  readonly frameRuntime = new SimulationFrames(this, {
    worldToSimulation: () => this.gpuSimulation._gpuWorldToSimulationNode,
    simulationToWorld: system => system.gpuSimulation._gpuSimulationToWorldNode,
    syncRenderers: () => this.syncRendererParents(),
    invalidateGPU: system => system.gpuSimulation._disposeGPUComputeCaches(),
    sourceIdentity: (parent, id) => {
      const slot = parent.gpuSimulation._gpuParticleSlotIds.indexOf(id);
      return { slot, generation: parent.gpuSimulation._gpuParticleSlotGenerations[slot] };
    },
    readback: (parent, requests) => parent.gpuSimulation._readbackGPUParticles(requests),
    lifecycle: () => this.gpuSimulation._gpuLifecycleGeneration,
    debug: (message, data) => this.gpuSimulation._logGPUDebug(message, data),
  });
  /** @internal Native GPU resource/execution owner. */
  readonly gpuSimulation = new GPUSimulation(this, {
    deltaTime: () => this.deltaTime,
    elapsedTime: () => this._elapsedTime,
    skippedTime: () => this._skippedTime,
    skippedClockWrap: () => this._skippedClockWrap,
    skipRender: () => this._skipIntermediateRender,
    nativeEmission: () => this._shouldExecuteEmittersOnGPU(),
    eventRoot: () => this._eventRoot(),
    sharedEvents: () => this._usesSharedGPUEvents(),
    journal: renderer => this._journal(renderer),
    emitterEventNames: emitter => this._emitterEventNames(emitter),
    dispatchSourceEvent: (...args) => this._dispatchSourceEvent(...args),
    spawnEvent: particle => this._dispatchGPUSpawnEvent(particle),
    collisionEvent: (particle, collision) => this._dispatchGPUCollisionEvent(particle, collision),
    particleDeath: (particle, fromGPUEvent) => this._dispatchParticleDeath(particle, fromGPUEvent),
    notifyDeath: particle => this._notifyParticleDeath(particle),
  });
  particles: Particle[] = [];
  emitters: Emitter[] = [];
  modules: Module[] = [];
  spatialEffects: SpatialEffect[] = [];
  renderers: Renderer[] = [];
  private _materialCopyRegistry?: MaterialCopyRegistry;
  /** @internal Appearance snapshots are shared only within this owned subsystem tree. */
  get materialCopyRegistry(): MaterialCopyRegistry {
    if (this._subSystemParent) return this._subSystemParent.materialCopyRegistry;
    return (this._materialCopyRegistry ??= new MaterialCopyRegistry());
  }

  /** @internal Detects registered appearances without scanning particles or creating an unused registry. */
  get hasMaterialCopySources(): boolean {
    return this._subSystemParent?.hasMaterialCopySources ?? (this._materialCopyRegistry?.sources.length ?? 0) > 1;
  }

  subSystems = new Map<ParticleSystem, SubSystemOptions>();
  boundingBox = new THREE.Box3();

  gravity: THREE.Vector3;
  gravityModifier: DynamicValue<number>;
  inheritVelocity: number;
  useSpatialEffects: boolean;
  spatialEffectBoundsFiltering: boolean;
  spatialEffectFilter?: (spatialEffect: SpatialEffect) => boolean;
  simulationSpeed: number;
  duration: number;
  prewarm: boolean;
  prewarmFPS: number;
  /**
   * Whether to divide large simulation intervals into smaller steps.
   *
   * When enabled (default), elapsed time is simulated in increments of at most
   * substepDeltaTime. Each increment performs normal emission, particle updates,
   * and spatial interactions, improving collisions, forces, emission timing, and
   * other time-dependent behavior after irregular or delayed frames.
   *
   * Substepping is more computationally expensive because multiple simulation
   * updates may occur during one rendered frame. Only the most recent maxCatchup
   * seconds are simulated; null estimates this limit from emitter lifetimes and
   * system duration. An internal step-count safeguard also bounds work.
   *
   * When disabled, the entire elapsed interval is processed in one simulation
   * step. Continuous births still receive distributed spawn times and per-particle
   * deltas, but spatial interactions, collisions, and nonlinear motion may be
   * inaccurate over large intervals. This is faster and may suit simple effects
   * or performance-sensitive applications.
   *
   * Neither mode guarantees exact reconstruction of missed frames.
   * @default true
   */
  substep: boolean;
  /** Maximum simulation step in seconds. Defaults to 1 / prewarmFPS. */
  substepDeltaTime: number;
  /** Maximum simulation seconds recovered per interval; null uses duration and finite emitter lifetimes.
   * @default null */
  maxCatchup: number | null;
  looping: boolean;
  endBehavior: EndBehavior;

  maxParticles: number = 10000;
  maxCullingMode: MaxCulling;
  simulationDistance: number;
  lod?: Partial<LODSettings>;
  /** Central population quality shared by emitters and renderers. */
  quality = 1;
  private _renderFrameToken: object = {};
  /** Shared per-step cache key for renderer spatial preprocessing. */
  get renderFrameToken(): object {
    return this._renderFrameToken;
  }

  useLiveCubemap: boolean;
  liveCubemap: LiveCubemap;
  private _gpuProcessing = true;
  /** Canonical GPU storage for renderer preprocessing and managed spatial queries. */
  get gpuParticleBuffers(): GPUParticleBufferState | undefined {
    return this.gpuSimulation._gpuBuffers;
  }
  /** Whether GPU simulation is requested; activation depends on renderer and components. */
  get gpuProcessing(): boolean {
    return this._gpuProcessing;
  }
  set gpuProcessing(value: boolean) {
    const next = Boolean(value);
    if (next === this._gpuProcessing) return;

    this._gpuProcessing = next;
    if (!this._gpuProcessingInitialized) return;

    // CPU and GPU particles have different authoritative storage. Switching is
    // a new run, not a state-conversion operation.
    this.reset(true);
  }
  gpuDebug: boolean;
  gpuDebugInterval: number;
  get particleOctree(): ParticleOctree<unknown> | undefined {
    return this.spatialRuntime.octree;
  }
  set particleOctree(value: ParticleOctree<unknown> | undefined) {
    this.spatialRuntime.octree = value;
  }
  private _processingMode?: 'cpu' | 'gpu';
  private _gpuProcessingInitialized = false;
  /** Whether the most recent simulation step selected GPU compute. */
  get isGPUProcessingActive(): boolean {
    return this.gpuSimulation._isGPUProcessingActive;
  }
  get liveParticleCount(): number {
    if (this.gpuSimulation._isGPUProcessingActive && this.gpuSimulation._gpuAllocationDiagnostics) {
      return this.gpuSimulation._gpuAllocationDiagnostics.activeCount;
    }
    return this.particles.reduce((count, particle) => count + (particle.alive ? 1 : 0), 0);
  }
  /** Current particle-buffer occupancy; allocation diagnostics can lag by an asynchronous readback. */
  get gpuBufferStats(): {
    allocated: number;
    activeSlots: number;
    live: number;
    usage: number;
  } {
    const allocated = this.gpuSimulation._gpuBuffers?.capacity ?? 0;
    const activeSlots = this.gpuSimulation._isGPUProcessingActive
      ? (this.gpuSimulation._gpuAllocationDiagnostics?.activeCount ?? 0)
      : this.particles.length;
    const live = this.liveParticleCount;

    return {
      allocated,
      activeSlots,
      live,
      usage: allocated > 0 ? live / allocated : 0,
    };
  }
  /** GPU lifecycle/collision event queue diagnostics. */
  get gpuEventStats(): {
    buffers: number;
    pending: number;
    overflowCount: number;
    nextDispatchSequence: number;
    readbackCount: number;
  } {
    return {
      readbackCount: this.eventRuntime._gpuEventReadbackCount,
      buffers: this.eventRuntime._gpuEventBuffer ? 1 : 0,
      pending: this.eventRuntime._gpuEventReadbacksPending,
      overflowCount: this.eventRuntime._gpuEventOverflowCount,
      nextDispatchSequence: this.eventRuntime._gpuNextEventDispatchSequence,
    };
  }

  /** Batched spatial-effect index, parameter upload, and refit diagnostics. */
  get gpuSpatialStats(): {
    batchableEffects: number;
    implementationTypes: number;
    bvhNodes: number;
    parameterVec4s: number;
    structuralBuilds: number;
    parameterUploads: number;
    parameterUploadBytes: number;
    leafUpdates: number;
    bvhRefits: number;
    bvhBoundsUploadBytes: number;
  } {
    const stats = this.gpuSimulation._gpuSpatialRegistry?.stats;
    return {
      batchableEffects: this.gpuSimulation._gpuSpatialRegistry?.records.length ?? 0,
      implementationTypes: this.gpuSimulation._gpuSpatialRegistry?.types.length ?? 0,
      bvhNodes: this.gpuSimulation._gpuSpatialRegistry?.bvhNodes.length ?? 0,
      parameterVec4s: this.gpuSimulation._gpuSpatialRegistry?.parameterAttribute.count ?? 0,
      structuralBuilds: stats?.structuralBuilds ?? 0,
      parameterUploads: stats?.parameterUploads ?? 0,
      parameterUploadBytes: stats?.parameterUploadBytes ?? 0,
      leafUpdates: stats?.leafUpdates ?? 0,
      bvhRefits: stats?.bvhRefits ?? 0,
      bvhBoundsUploadBytes: stats?.bvhBoundsUploadBytes ?? 0,
    };
  }

  /** Selective readback pool traffic and most recent latency. */
  get gpuSelectiveReadbackStats(): {
    buffers: number;
    pending: number;
    bytes: number;
    latencyMs: number;
    overflowCount: number;
  } {
    return {
      buffers: this.gpuSimulation._gpuSelectiveReadbacks.length,
      pending: this.gpuSimulation._gpuSelectiveReadbacks.filter(slot => slot.pending).length,
      bytes: this.gpuSimulation._gpuSelectiveReadbackBytes,
      latencyMs: this.gpuSimulation._gpuSelectiveReadbackLatencyMs,
      overflowCount: this.gpuSimulation._gpuSelectiveReadbackOverflowCount,
    };
  }

  /** Counts expensive graph/resource builds separately from uniform parameter uploads. */
  get gpuConfigurationStats(): {
    pipelineBuilds: number;
    resourceBuilds: number;
    parameterUploads: number;
  } {
    const modules = this.modules.flatMap(module => module.withDependents());
    return {
      pipelineBuilds: this.gpuSimulation._gpuPipelineBuildCount,
      resourceBuilds: this.gpuSimulation._gpuResourceBuildCount,
      parameterUploads:
        this.gpuSimulation._gpuParameters.uploadCount +
        this.emitters.reduce((total, emitter) => total + emitter.gpuParameterUploadCount, 0) +
        modules.reduce((total, module) => total + module.gpuParameterUploadCount, 0) +
        this.renderers.reduce((total, renderer) => total + renderer.gpuParameterUploadCount, 0),
    };
  }



  /** Finds modules by constructor (including subclasses) or the presence of all requested members.
   * Includes dependents before their owners, preserves attachment order, and returns each instance once.
   * Optional tags select overlapping modules; null/undefined tags on either side match all.
   * Does not search subsystem particle systems. Structural queries check presence, not member types;
   * supply the interface type and its identifying members explicitly because interfaces are erased. */
  getModules<T extends Module>(type: abstract new (...args: never[]) => T, tags?: Tag[] | null): T[];
  getModules<T>(
    type: (abstract new (...args: never[]) => T) | readonly (keyof T)[],
    tags?: Tag[] | null,
  ): Array<Module & T>;
  getModules(
    type: (abstract new (...args: never[]) => unknown) | readonly PropertyKey[],
    tags?: Tag[] | null,
  ): Module[] {
    const modules = new Set(this.modules.flatMap(module => module.withDependents()));
    return Array.from(modules).filter(module => (!tags || !module.tags || tagsIntersect(tags, module.tags))
      && (typeof type === 'function' ? module instanceof type : type.every(member => member in module)));
  }

  getGPUFilterTagMask(tags: Tag[] | undefined): number | undefined {
    return this.gpuSimulation._getGPUTagMask(tags);
  }

  getGPURendererTagMask(tags: Tag[] | undefined): number | undefined {
    return this.gpuSimulation._getGPUTagMask(tags);
  }

  /** Acquires a compatible system-owned grid, or registers a caller-owned instance. */
  acquireParticleSpatialGrid(
    options: ParticleSpatialGrid | Partial<ParticleSpatialGridOptions> = {},
  ): ParticleSpatialGrid {
    return this.spatialRuntime.acquireParticleSpatialGrid(options);
  }
  getParticleSpacing(particle: Particle, population: Particle[] = this.particles): number {
    return this.spatialRuntime.getParticleSpacing(particle, population, this.renderFrameToken, this.modules);
  }
  getParticleSpacingGPU(): PackedFloatStorage {
    return this.spatialRuntime.getParticleSpacingGPU(
      this.gpuSimulation._gpuBuffers!,
      this.sceneRenderer as WebGPURenderer,
      this.renderFrameToken,
    );
  }

  get gpuAllocationStats(): GPUAllocationDiagnostics | undefined {
    return this.gpuSimulation._gpuAllocationDiagnostics ?? this.gpuSimulation._gpuAllocationBuffer?.snapshot();
  }

  /** Audits built-in/custom emitter and subsystem eligibility for GPU-native emission. */
  getGPUEmissionSupport(): ParticleSystemGPUEmissionSupportReport {
    const emitters = this.emitters.map(emitter => emitter.getGPUEmissionSupport());
    const reasons = emitters.flatMap((report, index) =>
      report.supported ? [] : report.reasons.map(reason => `Emitter ${index}: ${reason}`),
    );
    const subsystems: ParticleSystemGPUEmissionSupportReport['subsystems'] = [];

    this.subSystems.forEach((options, subSystem) => {
      const subReasons: string[] = [];
      if (typeof options.shouldEmit === 'function' && !options.shouldEmitGPU) {
        subReasons.push('Subsystem shouldEmit function requires an explicit GPU predicate.');
      }
      if (options.emitOnCollision && !this.modules.some(module => module instanceof Collision && module.supportsGPU)) {
        subReasons.push('Collision-triggered GPU emission requires a GPU collision event producer.');
      }
      const childReport = subSystem.getGPUEmissionSupport();
      subReasons.push(...childReport.reasons.map(reason => `Child: ${reason}`));

      subsystems.push({
        system: subSystem,
        supported: subReasons.length === 0,
        reasons: subReasons,
      });
    });

    reasons.push(
      ...subsystems.flatMap((report, index) =>
        report.supported ? [] : report.reasons.map(reason => `Subsystem ${index}: ${reason}`),
      ),
    );

    return {
      supported: reasons.length === 0,
      reasons,
      emitters,
      subsystems,
    };
  }

  /** Returns the stable parent-before-child GPU subsystem schedule. */
  getGPUExecutionSchedule(): GPUSystemSchedule {
    return buildGPUSystemSchedule(this);
  }
  /** Behavior when an attached source dies or its slot is reused. Defaults to detach. */
  sourceLoss: 'detach' | 'kill' = 'detach';

  get simulationSpace(): SimulationSpace {
    return this.frameRuntime.simulationSpace;
  }
  set simulationSpace(value: SimulationSpace | `${SimulationSpace}`) {
    this.frameRuntime.simulationSpace = value;
  }
  get simulationSpaceTransform(): THREE.Object3D | THREE.Matrix4 | null {
    return this.frameRuntime.simulationSpaceTransform;
  }
  set simulationSpaceTransform(value: THREE.Object3D | THREE.Matrix4 | null) {
    this.frameRuntime.simulationSpaceTransform = value;
  }
  getSourceEmissionFrame(source?: SubSystemSource): THREE.Matrix4 | undefined {
    return this.frameRuntime.getSourceEmissionFrame(source);
  }
  getSourceProducer(source: SubSystemSource): ParticleSystem {
    return this.frameRuntime.getSourceProducer(source);
  }
  bindParticleSource(particle: Particle, source?: SubSystemSource): void {
    this.frameRuntime.bindParticleSource(particle, source);
  }
  getSimulationToWorldMatrix(target = new THREE.Matrix4()): THREE.Matrix4 {
    return this.frameRuntime.getSimulationToWorldMatrix(target);
  }
  simulationToWorld(position: THREE.Vector3): THREE.Vector3 {
    return this.frameRuntime.simulationToWorld(position);
  }
  worldToSimulation(position: THREE.Vector3): THREE.Vector3 {
    return this.frameRuntime.worldToSimulation(position);
  }
  getSimulationWorldQuaternion(target = new THREE.Quaternion()): THREE.Quaternion {
    return this.frameRuntime.getSimulationWorldQuaternion(target);
  }
  resolveSimulationFrame(particle?: Particle, target = new THREE.Matrix4()): THREE.Matrix4 {
    return this.frameRuntime.resolveSimulationFrame(particle, target);
  }
  getParticleEmissionTransform(source: SubSystemSource, inheritScale = 0, alignUpTo?: THREE.Vector3): THREE.Matrix4 {
    return this.frameRuntime.getParticleEmissionTransform(source, inheritScale, alignUpTo);
  }

  private _scene?: THREE.Scene;
  /** Current containing scene, available after attachment or renderer context capture. */
  get scene() {
    if (this._scene) return this._scene;

    let parent = this.parent;
    while (parent) {
      if (parent instanceof THREE.Scene) return parent;
      parent = parent.parent;
    }

    return undefined;
  }

  private _camera?: THREE.Camera;
  /** Active camera captured during rendering; undefined before the first render. */
  get sceneCamera() {
    return this._camera;
  }
  private readonly _sceneCameraQuaternion = new THREE.Quaternion();
  /** Cached world orientation of the last active render camera. */
  get sceneCameraQuaternion() {
    return this._sceneCameraQuaternion;
  }

  private _renderer?: THREE.WebGLRenderer | WebGPURenderer;
  /** Active renderer captured by the context object during rendering. */
  get sceneRenderer() {
    return this._renderer;
  }
  private _cameraDistanceSq = Number.MAX_SAFE_INTEGER;
  /** Squared camera distance used for component LOD; explicit advancement refreshes it without skipping steps. */
  get cameraDistanceSq(): number {
    return this._cameraDistanceSq;
  }

  private deltaTime = 0;
  private lastFrame: number;

  private readonly _subSystemOverrides = new Map<ParticleSystem, Partial<SubSystemOptions>>();

  /** Effective configuration is attachment-specific and never changes emitter properties. */
  getEmitterOptions(emitter: Emitter): SubSystemOptions {
    const overrides = this._subSystemParent?._subSystemOverrides.get(this) ?? {};
    return overrideEmitterOptions({ ...emitter.emission, eventScope: emitter.eventScope }, overrides, this.isSubSystem);
  }

  /** Checks subscription settings before building complete emission options. */
  private _emitterHasEvents(emitter: Emitter): boolean {
    const overrides = this._subSystemParent?._subSystemOverrides.get(this);
    return !!(
      (overrides?.events ?? emitter.emission.events ?? emitter.events).length ||
      (overrides?.onEvent ?? emitter.onEvent) ||
      (overrides?.emitOnSpawn ?? emitter.emitOnSpawn) ||
      (overrides?.emitOnDeath ?? emitter.emitOnDeath) ||
      (overrides?.emitOnCollision ?? emitter.emitOnCollision)
    );
  }

  private _emitterEventNames(emitter: Emitter): string[] {
    // Subscription reconciliation only needs selectors, not the full inherited emission configuration.
    const overrides = this._subSystemParent?._subSystemOverrides.get(this);
    const own = emitter.emission;
    return [
      ...new Set([
        ...(overrides?.events ?? own.events ?? emitter.events),
        ...eventNames(overrides?.onEvent ?? own.onEvent),
        ...((overrides?.emitOnSpawn ?? own.emitOnSpawn) ? ['spawn'] : []),
        ...((overrides?.emitOnDeath ?? own.emitOnDeath) ? ['death'] : []),
        ...((overrides?.emitOnCollision ?? own.emitOnCollision) ? ['collision'] : []),
      ]),
    ];
  }

  private _subSystemParent?: ParticleSystem;
  /** Whether a parent owns simulation and emission contexts for this system. */
  get isSubSystem(): boolean {
    return !!this._subSystemParent;
  }
  /** Immediate attachment parent; event scopes never traverse beyond this relationship. */
  get subSystemParent(): ParticleSystem | undefined {
    return this._subSystemParent;
  }

  /** Subscribes to this system's events; returns an idempotent unsubscribe function. */
  onEvent(
    names: string | readonly string[],
    consume: (event: SimulationEvent) => void,
    /** @internal */ receiver: boolean | EventReceiver = false,
  ): () => void {
    return this.eventRuntime.onEvent(names, consume, receiver);
  }

  private _routeEmitterEvent(event: SimulationEvent): void {
    const root = this._eventRoot();
    const route = (owner: ParticleSystem) => {
      for (const emitter of owner.emitters) {
        if (!owner._emitterHasEvents(emitter)) continue;
        if (!emitter.visibleSystems(owner).includes(event.origin)) continue;
        const options = owner.getEmitterOptions(emitter);
        if (!owner._subscribes(options, event.name)) continue;
        if (event.gpu && owner.gpuSimulation._canHandleNativeGPUEvent(event.origin, options, event.name)) continue;
        const source = event.source ?? owner._systemEmissionOrigin();
        if (!owner.emissionRuntime._canEmitForParticle(source, options)) continue;
        const hit = event.name === 'collision' ? (event.data as CollisionHit) : undefined;
        if (hit && hit.impulse.length() <= options.impulseThreshold) continue;
        owner.emissionRuntime._activateEventEmitterInstances(
          emitter,
          source,
          options,
          hit,
          cpuEventHandler(options.onEvent, event.name),
          event.data,
          event.origin,
          event,
        );
      }
      owner.subSystems.forEach((_options, child) => route(child));
    };
    route(root);
  }

  private _reconcileEventReceivers(): void {
    const root = this._eventRoot();
    const reconcile = (system: ParticleSystem) => {
      const synchronize = (component: EventReceiver) => {
        const emitter = component instanceof Emitter;
        if (emitter && !component.subscriptions.length && !system._emitterHasEvents(component)) return;
        const names = emitter ? system._emitterEventNames(component) : component.selectedEventNames;
        if (!names.length && !component.subscriptions.length) return;
        component.gpuNative =
          system.gpuProcessing &&
          ParticleSystem.isWebGPURenderer(system.sceneRenderer ?? root.sceneRenderer) &&
          (component instanceof Renderer
            ? component.supportsGPUEventInput
            : system.modules.every(module => module.supportsGPU));
        component.synchronize(
          system,
          emitter && system.isSubSystem ? 'parent' : 'local',
          names,
          emitter
            ? (system._subSystemParent?._subSystemOverrides.get(system)?.eventScope ?? component.eventScope)
            : undefined,
        );
      };
      for (const module of system.modules) for (const dependent of module.withDependents()) synchronize(dependent);
      for (const renderer of system.renderers) synchronize(renderer);
      for (const emitter of system.emitters) synchronize(emitter);
      system.subSystems.forEach((_options, child) => reconcile(child));
    };
    reconcile(root);
  }

  /** @internal Event IDs are stable within the originating system. */
  getGPUEventType(name: string): number | undefined {
    return this.eventRuntime._eventTypes.get(name);
  }

  private _eventRoot(): ParticleSystem {
    let root = this._subSystemParent;
    if (!root) return this;

    while (root._subSystemParent) root = root._subSystemParent;
    return root;
  }

  private _usesSharedGPUEvents(): boolean {
    const uses = (system: ParticleSystem): boolean =>
      system.modules.some(module => module.events.length > 0) ||
      system.renderers.some(renderer => renderer.events.length > 0) ||
      system.emitters.some(
        emitter =>
          emitter.events.length > 0 ||
          emitter.onEvent !== undefined ||
          emitter.emitOnSpawn !== undefined ||
          emitter.emitOnDeath !== undefined ||
          emitter.emitOnCollision !== undefined,
      ) ||
      [...system._subSystemOverrides.values()].some(options => options.eventScope !== undefined) ||
      [...system.subSystems.keys()].some(uses);
    return uses(this._eventRoot());
  }

  /** @internal Shared native batch prepared once at a component execution boundary. */
  beginGPUEventExecution(receiver: EventReceiver): GPUEventBatch {
    const renderer = this.sceneRenderer;
    const journal = this._eventRoot().eventRuntime._sharedGPUEvents;
    if (!journal || !receiver.subscriptions.length || !ParticleSystem.isWebGPURenderer(renderer)) return emptyGPUEvents;
    const slot = journal.snapshot(receiver, renderer);
    const origins = receiver.visibleSystems(this);
    const batch = new SharedGPUEventBatch(journal.createReader(slot), origins, receiver.subscriptions);
    return batch;
  }

  private _registerGPUEventReceivers(journal: GPUEventBufferState, renderer: WebGPURenderer): void {
    const register = (owner: ParticleSystem) => {
      for (const component of [
        ...owner.modules.flatMap(module => module.withDependents()),
        ...owner.emitters,
        ...owner.renderers,
      ]) {
        const receiver = component;
        if (receiver.gpuNative && receiver.subscriptions.length) journal.register(receiver, renderer);
      }
      owner.subSystems.forEach((_options, child) => register(child));
    };
    register(this._eventRoot());
  }

  private _journal(renderer: WebGPURenderer): GPUEventBufferState {
    const root = this._eventRoot();
    let capacity = 0;
    const count = (system: ParticleSystem) => {
      capacity += Math.max(1, system.maxParticles) * 4;
      system.subSystems.forEach((_options, child) => count(child));
    };
    if (!root.eventRuntime._sharedGPUEvents) count(root);
    return root.eventRuntime.acquireJournal(renderer, Math.min(262144, Math.max(4096, capacity)), journal => {
      root._reconcileEventReceivers();
      root._registerGPUEventReceivers(journal, renderer);
    });
  }

  private _playing = true;
  /** Whether the system is emitting; pause is a separate flag. */
  get playing(): boolean {
    return this._playing;
  }

  private _paused = false;
  /** Whether simulation is frozen by pause(). */
  get paused(): boolean {
    return this._paused;
  }

  private _ended = false;
  /** Whether a nonlooping duration has ended or stop() was called. */
  get ended(): boolean {
    return this._ended;
  }

  private _elapsedTime = 0;
  private _prewarmed = false;
  private _isPrewarming = false;
  private _lodHelper: LODHelper;

  private _destroyed = false;
  /** Whether permanent destruction has completed. */
  get destroyed(): boolean {
    return this._destroyed;
  }

  private readonly _rendererObjects = new Set<THREE.Object3D>();
  private readonly _worldRendererRoot = new THREE.Group();
  private _contextCaptureDummy: THREE.Mesh;
  private readonly _simulationDistanceWorldPos = new THREE.Vector3();
  private readonly _simulationDistanceCameraWorldPos = new THREE.Vector3();
  private readonly _emitterContextWorldPosition = new THREE.Vector3();
  private readonly _emitterContextPreviousWorldPosition = new THREE.Vector3();
  private readonly _emitterContextVelocity = new THREE.Vector3();
  private _hasEmitterContextPreviousWorldPosition = false;
  private readonly _particleBoundsMin = new THREE.Vector3();
  private readonly _particleBoundsMax = new THREE.Vector3();
  private readonly _particleBoundsSize = new THREE.Vector3(1, 1, 1);
  private readonly _spatialEffectTravelBounds = new THREE.Box3();
  private readonly _spatialEffectBoundsInverse = new THREE.Matrix4();
  private readonly _directionNormalMatrix = new THREE.Matrix3();
  private readonly _inverseWorldMatrix = new THREE.Matrix4();
  private _cpuSubSystemFrameActive = false;

  /** Creates a playing, looping system; omitted emitters and renderers receive sprite defaults. */
  constructor(options: Partial<ParticleSystemOptions> = {}) {
    super();

    this.emitters = acceptMultiple(options.emitters ?? new Emitter()) ?? [];
    this.renderers = acceptMultiple(options.renderers ?? new SpriteRenderer()) ?? [];
    this.modules = acceptMultiple(options.modules) ?? [];
    this.spatialEffects = acceptMultiple(options.spatialEffects) ?? [];
    this.spatialEffectFilter = options.spatialEffectFilter;
    this.useSpatialEffects = options.useSpatialEffects ?? true;
    this.spatialEffectBoundsFiltering = options.spatialEffectBoundsFiltering ?? false;
    this.simulationSpeed = options.simulationSpeed ?? 1;
    this._gpuProcessing = options.gpuProcessing ?? true;
    this.gpuDebug = options.gpuDebug ?? false;
    this.gpuDebugInterval = Math.max(1, options.gpuDebugInterval ?? GlobalSettings.GPU_DEBUG_INTERVAL);
    this.duration = options.duration ?? 10;
    this.prewarm = options.prewarm ?? false;
    this.prewarmFPS = options.prewarmFPS ?? 24;
    this.substep = options.substep ?? true;
    this.maxCatchup = options.maxCatchup ?? null;
    this.substepDeltaTime =
      options.substepDeltaTime ?? 1 / (Number.isFinite(this.prewarmFPS) && this.prewarmFPS > 0 ? this.prewarmFPS : 24);
    this.looping = options.looping ?? true;
    this.endBehavior = (options.endBehavior as EndBehavior) ?? EndBehavior.None;

    this.maxParticles = Math.max(options.maxParticles ?? this.maxParticles, 0);
    this.maxCullingMode = (options.maxCullingMode as MaxCulling) ?? MaxCulling.New;
    this.simulationDistance = Math.max(options.simulationDistance ?? 0, 0);
    this.lod = options.lod;
    this._lodHelper = new LODHelper(this.lod);

    // Init live cubemap, even if unused
    this.useLiveCubemap =
      options.useLiveCubemap ??
      Boolean(options.cubemapSettings || options.liveCubemapFPS || options.liveCubemapResolutionScale);
    this.liveCubemap = new LiveCubemap({
      ...(options.cubemapSettings ?? {}),
      fps: options.cubemapSettings?.fps ?? options.liveCubemapFPS,
      resolutionScale: options.cubemapSettings?.resolutionScale ?? options.liveCubemapResolutionScale,
      intensity: options.cubemapSettings?.intensity ?? options.liveCubemapIntensity,
    });
    this.liveCubemap.setup(this);

    // If gravity is passed in, gravityModifier will be set to 1.
    // In effect, this means gravity will be turned off by default,
    // but if either gravity or gravityModifier are specified, they will be used.
    this.gravity = options.gravity ?? new THREE.Vector3(0, -9.81, 0);
    this.gravityModifier = options.gravityModifier ?? (options.gravity ? 1 : 0);
    this.inheritVelocity = Math.max(0, options.inheritVelocity ?? 0);
    this.frameRuntime._simulationSpace =
      (options.simulationSpace as SimulationSpace) ?? this.frameRuntime._simulationSpace;
    this.frameRuntime._simulationSpaceExplicit = options.simulationSpace !== undefined;
    this.frameRuntime._simulationSpaceTransform = options.simulationSpaceTransform ?? null;
    this.sourceLoss = options.sourceLoss ?? 'detach';
    this._worldRendererRoot.name = 'ParticleSystem World Renderers';

    this.lastFrame = Date.now();

    this.emitters.forEach(e => e.setup(this));
    this.renderers.forEach(r => r.setup(this));

    // Store these here so that other renderers/modules can access easily.
    // The dummy renders no color, but avoids frustum culling so offscreen roots
    // can still capture the active renderer, scene, and camera.
    this._contextCaptureDummy = new THREE.Mesh();
    this._contextCaptureDummy.frustumCulled = false;
    this.add(this._contextCaptureDummy);

    this._contextCaptureDummy.onBeforeRender = (renderer, scene, camera) => {
      if (LiveCubemap.isLiveCubemapCamera(camera)) return;

      this._renderer = renderer;
      this._scene = scene;
      this._camera = camera;
      camera.getWorldQuaternion(this._sceneCameraQuaternion);
    };

    // Cleanup on remove from scene. Anything done here should not be permanent.
    // If the system is removed from one scene and added to another, it should
    // still function.
    this.addEventListener('removed', () => this.cleanup());
    this._gpuProcessingInitialized = true;
  }

  /*
   * PROCESSING
   */

  /** Advances from wall-clock time, respecting pause, simulation distance, and population LOD. */
  update(): void {
    if (this._destroyed) return;

    // Subsystems are owned and ticked by parent, avoid double update
    if (this._subSystemParent) return;
    if (this.gpuProcessing) buildGPUSystemSchedule(this);

    const now = Date.now();
    const nextDeltaTime = this._scaleDeltaTime((now - this.lastFrame) / 1000);

    // Check for pauses
    if (this._paused) {
      this.deltaTime = nextDeltaTime;
      this.lastFrame = now;
      this._updateEmitterContextVelocity();
      return;
    }

    const simulationDistanceSq = this._getSimulationDistanceSq();
    this._cameraDistanceSq = simulationDistanceSq;
    this._updateLODQuality();

    if (!this._isWithinSimulationDistance(simulationDistanceSq)) {
      this.deltaTime = nextDeltaTime;
      this.lastFrame = now;
      this._updateEmitterContextVelocity();
      return;
    }

    this.deltaTime = nextDeltaTime;
    this.lastFrame = now;

    this.syncRendererParents();
    this._updateEmitterContextVelocity();

    this._prewarm();

    this._advanceSimulationInterval(false);

    // Cubemap updates require a renderer and run only on normal display updates.
    this._updateLiveCubemaps();
    this._handleEndBehavior();
  }

  private _updateLiveCubemaps(): void {
    if (this._paused || this._destroyed) return;
    if (this.useLiveCubemap) this.liveCubemap.update(this.scene, this.sceneRenderer, this.deltaTime);
    this.subSystems.forEach((_options, child) => child._updateLiveCubemaps());
  }

  /**
   * Advances a root system synchronously using fixed simulation steps.
   * @param frames - Nonnegative integer number of steps.
   * @param deltaTime - Seconds per step, before simulationSpeed. Defaults to 1 / 60.
   * @remarks
   * Reuses prewarm's simulation path, including emission, lifecycle events, modules,
   * spatial effects, and owned subsystems. Paused, destroyed, and parent-owned
   * systems do not advance. Does not start playback or perform implicit prewarm.
   * Camera distance does not skip explicit steps; population LOD still applies. Live cubemap
   * capture is deferred to normal updates; render the scene after advancing.
   * Finite systems can naturally end, including their configured end behavior.
   */
  public advanceFrames(frames: number, deltaTime: number = 1 / 60): void {
    if (!Number.isSafeInteger(frames) || frames < 0) {
      throw new RangeError('frames must be a nonnegative safe integer');
    }
    if (!Number.isFinite(deltaTime) || deltaTime <= 0) {
      throw new RangeError('deltaTime must be a positive finite number of seconds');
    }
    if (this._destroyed || this._paused || this._subSystemParent || frames === 0) return;

    const previousDeltaTime = this.deltaTime;
    try {
      for (let frame = 0; frame < frames && !this._destroyed && !this._paused; frame += 1) {
        this.deltaTime = this._scaleDeltaTime(deltaTime);
        this._cameraDistanceSq = this._getSimulationDistanceSq();
        this.syncRendererParents();
        this._updateEmitterContextVelocity();
        this._advanceSimulationInterval();
      }
    } finally {
      this.deltaTime = previousDeltaTime;
      this.lastFrame = Date.now();
    }
  }

  /** Shared simulation path for display updates, prewarm, and explicit advancement. */
  private _updateLODQuality(): void {
    this._lodHelper.configure(this.lod);
    this.quality = this.lod ? this._lodHelper.getScale(Math.sqrt(this.cameraDistanceSq)) : 1;
    this.gpuSimulation._gpuLODQuality.value = this.quality;
  }

  private _advanceSimulationStep(handleEndBehavior: boolean = true): void {
    this._reconcileEventReceivers();
    const renderer = this.sceneRenderer;
    if (ParticleSystem.isWebGPURenderer(renderer) && this._usesSharedGPUEvents()) {
      const journal = this._journal(renderer);
      journal.reset(this.eventRuntime._gpuEventFrameSequence + 1);
      journal.initialize(renderer);
      this._registerGPUEventReceivers(journal, renderer);
    }
    this.eventRuntime.flush();
    this._updateLODQuality();
    if (this._playing) this._updateSystemTime();
    this.emissionRuntime._updateEmitterInstances();
    this._processParticles();
    this._updateSubSystems();
    if (handleEndBehavior) this._handleEndBehavior();
  }

  private _skipIntermediateRender = false;
  private _particlesIntegrated = false;

  /** @internal Shared by CPU modules and spatial effects, including conditions. */
  getParticleDeltaTime(particle: Particle, deltaTime: number): number {
    return particle.getSimulationDeltaTime(deltaTime, this._particlesIntegrated);
  }

  private _advanceSimulationInterval(handleEndBehavior = true): void {
    const elapsed = this.deltaTime;
    const step = this.substepDeltaTime;
    if (!this.substep || !Number.isFinite(step) || step <= 0) {
      this._advanceSimulationStep(handleEndBehavior);
      return;
    }
    // Read definitions directly so runtime edits to lifetimes/duration take effect immediately.
    const automatic = Math.max(0, this.duration, ...this.emitters.map(emitter => emitter.getMaxLifetime() ?? 0));
    const configured = this.maxCatchup === null ? automatic : this.maxCatchup;
    const budget = Math.min(240 * step, Number.isNaN(configured) ? automatic : Math.max(0, configured));
    if (elapsed <= Math.min(step, budget)) {
      this._advanceSimulationStep(handleEndBehavior);
      return;
    }
    let remaining = Math.min(elapsed, budget);
    const discarded = Math.max(0, elapsed - remaining);
    try {
      if (discarded > 0) this._skipSimulationTime(discarded);
      do {
        this.deltaTime = Math.min(step, remaining);
        remaining = Math.max(0, remaining - this.deltaTime);
        this._skipIntermediateRender = remaining > 1e-12;
        this._advanceSimulationStep(handleEndBehavior || this._skipIntermediateRender);
        this._clearSkippedSimulationTime();
      } while (remaining > 1e-12 && !this._destroyed && !this._paused);
    } finally {
      this.deltaTime = elapsed;
      this._skipIntermediateRender = false;
      this._clearSkippedSimulationTime();
    }
  }

  private _discardingTime = false;
  private _skippedTime = 0;
  private _skippedClockWrap = 0;

  /** Advances only clocks over discarded history. No modifiers, events, births or rendering. */
  private _skipSimulationTime(seconds: number, parentSources?: Iterable<SubSystemSource>): void {
    if (this._paused || this._destroyed || seconds <= 0) return;
    const previousDelta = this.deltaTime;
    this.deltaTime = seconds;
    this._skippedTime += seconds;
    this._discardingTime = true;
    try {
      if (this._playing) {
        this._elapsedTime += seconds;
        if (this.looping && this.duration > 0 && Number.isFinite(this.duration)) {
          this._skippedClockWrap = Math.floor(this._elapsedTime / this.duration) * this.duration;
          this._elapsedTime -= this._skippedClockWrap;
        } else if (!this.looping && !this.isSubSystem && this._elapsedTime >= this.duration) {
          this._elapsedTime = this.duration;
          // Finish lifecycle normally at the next retained step.
          this._ended = true;
        }
      }
      this.emissionRuntime._updateEmitterInstances(parentSources);
      for (const source of this.emissionRuntime._emissionSources.values()) {
        source.realtime += seconds * 1000;
        source.time = source.realtime / (Math.max(this.duration, Number.EPSILON) * 1000);
      }
      const buffers = this.gpuSimulation._gpuBuffers;
      const renderer = this.sceneRenderer;
      if (this.gpuSimulation._isGPUProcessingActive && buffers && ParticleSystem.isWebGPURenderer(renderer)) {
        this.gpuSimulation.skipTime(renderer, buffers);
      } else
        this.particles.forEach(particle => {
          particle.advanceAge(seconds);
          particle.time = particle.realtime / 1000 / particle.lifetime;
        });
      const sources = [...this.particles, ...this.emissionRuntime._emissionSources.values()];
      this.subSystems.forEach((_options, child) => child._skipSimulationTime(child._scaleDeltaTime(seconds), sources));
    } finally {
      this.deltaTime = previousDelta;
      this._discardingTime = false;
    }
  }

  private _clearSkippedSimulationTime(): void {
    this._skippedTime = 0;
    this._skippedClockWrap = 0;
    this.subSystems.forEach((_options, child) => child._clearSkippedSimulationTime());
  }

  private _scaleDeltaTime(deltaTime: number): number {
    const speed = Number.isFinite(this.simulationSpeed) ? Math.max(0, this.simulationSpeed) : 1;

    return deltaTime * speed;
  }

  private _processParticles() {
    this._particlesIntegrated = false;
    this._renderFrameToken = {};
    this._updateLODQuality();
    // LOD destruction is deliberately separate from lifecycle death notification.
    if (!this.gpuSimulation._isGPUProcessingActive && this.quality < 1) {
      this.particles = this.particles.filter(particle => {
        if (particle.lodPriority < this.quality) return true;
        particle.alive = false;
        this.subSystems.forEach((_options, subSystem) => {
          subSystem.emitters.forEach(emitter => emitter.clearContext(particle.id, subSystem));
        });
        return false;
      });
    }
    // Cull particles
    if (this.particles.length > this.maxParticles) {
      if (this.gpuSimulation._usesGPUStableParticleSlots()) {
        this.particles.slice(this.maxParticles).forEach(particle => {
          if (!particle.alive) return;
          particle.alive = false;
          this._notifyParticleDeath(particle);
        });
        this.particles.length = this.maxParticles;
      } else if (this.maxCullingMode == MaxCulling.New) this.particles.splice(this.maxParticles);
      else this.particles.splice(0, this.particles.length - this.maxParticles);
    }

    this.particles.forEach(particle => particle.restore());
    if (!this.gpuSimulation._isGPUProcessingActive) this.frameRuntime._updateCPUSourceFrames();
    this.updateBoundingBox();

    // Module preparation
    const modules = this.modules.flatMap(module => module.withDependents());
    const spatialEffects = this._getSpatialEffects();

    this.emitters.forEach(emitter => emitter.syncGPUConfiguration());
    modules.forEach(module => module.syncGPUConfiguration());
    this.renderers.forEach(renderer => renderer.syncGPUConfiguration());
    this.gpuSimulation._gpuParameters.sync();

    this._discoverEventTypes();
    this.gpuSimulation._prepareGPUTagRegistry(modules, spatialEffects);

    const processingMode = this._canProcessParticlesOnGPU(modules, spatialEffects) ? 'gpu' : 'cpu';
    if (this._processingMode && this._processingMode !== processingMode) {
      this.reset(false);
    }
    this._processingMode = processingMode;

    if (processingMode === 'gpu') {
      this.gpuSimulation._processParticlesGPU(modules, spatialEffects);
      return;
    }

    this.gpuSimulation._isGPUProcessingActive = false;

    modules.forEach(module => module.beginExecution(this, this.deltaTime));
    modules.forEach(module => module.prepare(module.executionContext!));

    const modifiers = [...modules, ...spatialEffects];

    const permanentPreMovementModifiers = modifiers
      .filter(modifier => modifier.priority < 0)
      .sort((a, b) => a.priority - b.priority);
    const transientPreMovementModifiers = modifiers
      .filter(modifier => modifier.priority >= 0 && modifier.priority < 1)
      .sort((a, b) => a.priority - b.priority);
    const transientRenderModifiers = modifiers
      .filter(modifier => modifier.priority >= 1)
      .sort((a, b) => a.priority - b.priority);

    // Run permanent pre-movement modules
    permanentPreMovementModifiers.forEach(modifier =>
      modifier instanceof Module
        ? modifier.modify(this.particles, this.deltaTime, modifier.executionContext!)
        : modifier.modify(this.particles, this.deltaTime, this),
    );

    const transientBaseValues =
      transientPreMovementModifiers.length > 0 ? this.particles.map(particle => particle.snapshot()) : undefined;

    // Run transient pre-movement modules
    transientPreMovementModifiers.forEach(modifier =>
      modifier instanceof Module
        ? modifier.modify(this.particles, this.deltaTime, modifier.executionContext!)
        : modifier.modify(this.particles, this.deltaTime, this),
    );

    // Update particles, caching permanent state before render-time transients.
    this._updateParticles(transientBaseValues);
    this._particlesIntegrated = true;

    if (!transientBaseValues) {
      this.particles.forEach(particle => particle.cache());
    }

    // Prewarming advances authoritative simulation state only. Rendering these
    // intermediate CPU frames mutates instance matrices immediately before a
    // GPU restart and has no effect on the resulting simulation.
    if (!this._isPrewarming && !this._skipIntermediateRender) {
      transientRenderModifiers.forEach(modifier =>
        modifier instanceof Module
          ? modifier.modify(this.particles, this.deltaTime, modifier.executionContext!)
          : modifier.modify(this.particles, this.deltaTime, this),
      );

      this.renderers.forEach(renderer => {
        renderer.update(this.particles, this, this.deltaTime);
      });
    }
    this._particlesIntegrated = false;
  }

  private _canProcessParticlesOnGPU(modules: Module[], spatialEffects: SpatialEffect[]): boolean {
    const gpuSpatialEffects = spatialEffects.filter(spatialEffect => spatialEffect.supportsGPU);
    const hasCPUInputRenderer = this.renderers.some(renderer => !renderer.supportsGPUInput);
    const hasRenderTimeModifier = [...modules, ...gpuSpatialEffects].some(modifier => modifier.priority >= 1);

    return (
      this.gpuProcessing &&
      ParticleSystem.isWebGPURenderer(this.sceneRenderer) &&
      !this.gpuSimulation._gpuTagOverflow &&
      !(hasCPUInputRenderer && hasRenderTimeModifier) &&
      modules.every(module => module.supportsGPU)
    );
  }

  private _shouldExecuteEmittersOnGPU(): boolean {
    if (this._cpuSubSystemFrameActive) return false;

    const modules = this.modules.flatMap(module => module.withDependents());
    const spatialEffects = this._getSpatialEffects();
    this._discoverEventTypes();
    this.gpuSimulation._prepareGPUTagRegistry(modules, spatialEffects);

    return this._canProcessParticlesOnGPU(modules, spatialEffects) && this.emitters.length > 0;
  }

  /**
   * Predicts peak population from rate * lifetime plus configured bursts, capped by maxParticles.
   * Uses the GPU allocation estimator without its minimum-buffer/power-of-two padding.
   * Results are shared within a simulation step. Optional tags conservatively select emitters.
   * Movement-driven emission, event subsystems and opaque TSL values may require later growth.
   */
  /** Reads selected fields from GPU particles. */
  public selectiveReadback(
    limit = Number.POSITIVE_INFINITY,
    fields?: readonly GPUParticleReadbackField[],
  ): Promise<GPUSelectiveReadbackResult[]> {
    return this.gpuSimulation.selectiveReadback(limit, fields);
  }

  public estimateParticleCount(tags?: readonly Tag[]): number {
    const inputs: unknown[] = [GlobalSettings.GPU_DYNAMIC_VALUE_RESOLUTION];
    const track = (value: unknown, depth = 0): void => {
      if (depth > 8) return;
      if (Array.isArray(value) || value instanceof Set) {
        const values = Array.from(value);
        inputs.push(value, values.length);
        values.forEach(item => track(item, depth + 1));
      } else {
        inputs.push(value);
        const node = value as { isNode?: boolean; value?: unknown } | undefined;
        if (node?.isNode) inputs.push(node.value);
      }
    };
    this.emitters.forEach(emitter => {
      inputs.push(emitter, JSON.stringify(emitter.tags), emitter.bursts.length);
      track(emitter.rate);
      track(emitter.initialValues.lifetime ?? 1);
      emitter.bursts.forEach(burst => track(burst.count));
    });
    if (
      this._populationEstimateToken !== this.renderFrameToken ||
      inputs.length !== this._populationEstimateInputs.length ||
      inputs.some((value, i) => value !== this._populationEstimateInputs[i])
    ) {
      this._populationEstimateInputs = inputs;
      this._populationEstimates.clear();
      this._populationEstimateToken = this.renderFrameToken;
    }
    const key = JSON.stringify(tags ? [...tags].sort() : null);
    const cached = this._populationEstimates.get(key);
    if (cached !== undefined) return Math.min(cached, Math.max(0, this.maxParticles));
    const maximum = (value: DynamicValue<number>) =>
      maximumDynamicNumber(value, GlobalSettings.GPU_DYNAMIC_VALUE_RESOLUTION);
    const predicted = this.emitters.reduce((total, emitter) => {
      if (tags && !tagsIntersect([...tags], emitter.tags ?? [])) return total;
      return (
        total +
        maximum(emitter.rate) * maximum(emitter.initialValues.lifetime ?? 1) +
        emitter.bursts.reduce((sum, burst) => sum + maximum(burst.count), 0)
      );
    }, 0);
    const result = Math.ceil(predicted);
    this._populationEstimates.set(key, result);
    return Math.min(result, Math.max(0, this.maxParticles));
  }

  private _populationEstimateToken?: object;
  private _populationEstimateInputs: unknown[] = [];
  private readonly _populationEstimates = new Map<string, number>();

  private _notifyParticleDeath(particle: Particle): void {
    this._dispatchParticleDeath(particle);
  }

  private _dispatchParticleDeath(particle: Particle, fromGPUEvent = false): void {
    this._notifyDeath(particle, fromGPUEvent);

    this.subSystems.forEach((options, subSystem) => {
      if (fromGPUEvent && subSystem.gpuSimulation._canUpdateAsGPUSubSystem(this, options)) return;
      subSystem.emitters.forEach(emitter => emitter.clearContext(particle.id, subSystem));
    });
  }

  private _compactExpiredParticles(): void {
    const particles = this.particles;
    const originalLength = particles.length;
    let writeIndex = 0;

    for (let readIndex = 0; readIndex < originalLength; readIndex += 1) {
      const particle = particles[readIndex];

      if (!particle.alive || particle.realtime > particle.lifetime * 1000) {
        particle.alive = false;
        this._notifyParticleDeath(particle);
        continue;
      }

      particles[writeIndex] = particle;
      writeIndex += 1;
    }

    particles.length = writeIndex;
  }

  private _getSpatialEffects(): SpatialEffect[] {
    if (!this.useSpatialEffects) return [];

    const accepts = (spatialEffect: SpatialEffect) =>
      spatialEffect.modifiesParticles &&
      (!this.spatialEffectFilter || this.spatialEffectFilter(spatialEffect)) &&
      this._spatialEffectOverlapsTravelBounds(spatialEffect);
    const spatialEffects = this.spatialEffects.filter(accepts);

    this.scene?.traverse(object => {
      if (object instanceof SpatialEffect && accepts(object) && !spatialEffects.includes(object))
        spatialEffects.push(object);
    });

    return spatialEffects;
  }

  private _spatialEffectOverlapsTravelBounds(effect: SpatialEffect): boolean {
    if (!this.spatialEffectBoundsFiltering || !effect.usesBuiltInTest || effect.inverted) return true;

    const hasParticles =
      this.particles.some(particle => particle.alive) ||
      (this.gpuSimulation._gpuAllocationDiagnostics?.activeCount ?? 0) > 0;
    if (!hasParticles || this.boundingBox.isEmpty()) return true;

    let maxVelocity = this.gpuSimulation._isGPUProcessingActive
      ? (this.gpuSimulation._gpuAllocationDiagnostics?.maxVelocity ?? 0)
      : 0;
    if (!this.gpuSimulation._isGPUProcessingActive) {
      this.particles.forEach(particle => {
        if (!particle.alive) return;
        maxVelocity = Math.max(maxVelocity, particle.velocity.length() * Math.abs(particle.speed));
      });
    }
    const gpuMirrorInterval = GlobalSettings.GPU_READBACK_RATE > 0 ? 1 / GlobalSettings.GPU_READBACK_RATE : 0;
    const travelTime = Math.max(this.deltaTime, this.gpuSimulation._isGPUProcessingActive ? gpuMirrorInterval : 0);
    this._spatialEffectTravelBounds.copy(this.boundingBox).expandByScalar(maxVelocity * travelTime);

    const effectBounds = effect.getWorldBounds();
    if (this.simulationSpace !== SimulationSpace.World) {
      this.updateWorldMatrix(true, false);
      this._spatialEffectBoundsInverse.copy(this.getSimulationToWorldMatrix()).invert();
      effectBounds.applyMatrix4(this._spatialEffectBoundsInverse);
    }
    return this._spatialEffectTravelBounds.intersectsBox(effectBounds);
  }

  private _updateParticles(transientBaseValues?: ParticleCachedValues[]) {
    const particles = this.particles;
    const originalLength = particles.length;
    let writeIndex = 0;

    // Compact survivors in place. This preserves order without per-death O(n) splices.
    for (let readIndex = 0; readIndex < originalLength; readIndex += 1) {
      const p = particles[readIndex];
      const transientBase = transientBaseValues?.[readIndex];
      const transientFrame = transientBase ? p.snapshot() : undefined;

      if (!p.alive) {
        this._notifyParticleDeath(p);
        continue;
      }

      const deltaTime = p.getSimulationDeltaTime(this.deltaTime);

      // Apply gravity
      const gravityScale = deltaTime * evaluateDynamicNumber(this.gravityModifier, p.time, p.id);
      p.velocity.addScaledVector(this.gravity, gravityScale);

      // Update time
      p.advanceAge(this.deltaTime);
      p.time = p.realtime / 1000 / p.lifetime;

      // Update transform
      p.position.addScaledVector(p.velocity, deltaTime * p.speed);
      p.rotation.addScaledVector(p.angularVelocity, deltaTime * p.speed);
      p.scale.addScaledVector(p.scalarVelocity, deltaTime * p.speed);

      // Update velocities
      p.velocity.addScaledVector(p.acceleration, deltaTime * p.speed);
      p.angularVelocity.addScaledVector(p.angularAcceleration, deltaTime * p.speed);
      p.scalarVelocity.addScaledVector(p.scalarAcceleration, deltaTime * p.speed);

      // Kill old particles
      if (p.realtime > p.lifetime * 1000) {
        p.alive = false;
        this._notifyParticleDeath(p);
        continue;
      }

      if (transientBase && transientFrame) {
        p.cacheValues(this._getAdvancedPermanentValues(p, transientBase, transientFrame, gravityScale, deltaTime));
      }

      particles[writeIndex] = p;
      writeIndex += 1;
    }

    const appendedCount = particles.length - originalLength;
    for (let appendIndex = 0; appendIndex < appendedCount; appendIndex += 1) {
      particles[writeIndex + appendIndex] = particles[originalLength + appendIndex];
    }

    if (writeIndex !== originalLength) {
      particles.length = writeIndex + appendedCount;
    }
  }

  /** Recomputes particle bounds used by spatial processing and renderer helpers. */
  public updateBoundingBox(): void {
    if (
      this.gpuSimulation._isGPUProcessingActive &&
      this.gpuSimulation._gpuCPUMirrorStale &&
      this.gpuSimulation._gpuAllocationDiagnostics?.bounds
    ) {
      this.boundingBox.copy(this.gpuSimulation._gpuAllocationDiagnostics.bounds);
      return;
    }

    this.boundingBox.makeEmpty();

    this.particles.forEach(particle => {
      const particleRadius = Math.max(
        Math.abs(particle.scale.x),
        Math.abs(particle.scale.y),
        Math.abs(particle.scale.z),
        Number.EPSILON,
      );

      this._particleBoundsMin.copy(particle.position).addScalar(-particleRadius);
      this._particleBoundsMax.copy(particle.position).addScalar(particleRadius);
      this.boundingBox.expandByPoint(this._particleBoundsMin);
      this.boundingBox.expandByPoint(this._particleBoundsMax);
    });

    if (this.boundingBox.isEmpty()) {
      this.boundingBox.setFromCenterAndSize(this._particleBoundsMin.set(0, 0, 0), this._particleBoundsSize);
    }
  }

  private _getAdvancedPermanentValues(
    particle: Particle,
    base: ParticleCachedValues,
    frame: ParticleCachedValues,
    gravityScale: number,
    deltaTime: number,
  ): ParticleCachedValues {
    const next = particle.snapshot();
    const frameVelocity = frame.velocity.clone().addScaledVector(this.gravity, gravityScale);
    const baseVelocity = base.velocity.clone().addScaledVector(this.gravity, gravityScale);

    next.lifetime = base.lifetime;
    next.position.copy(base.position).addScaledVector(frameVelocity, deltaTime * frame.speed);
    next.orbitCenter.copy(base.orbitCenter);
    next.rotation.copy(base.rotation).addScaledVector(frame.angularVelocity, deltaTime * frame.speed);
    next.scale.copy(base.scale).addScaledVector(frame.scalarVelocity, deltaTime * frame.speed);
    next.velocity.copy(baseVelocity).addScaledVector(base.acceleration, deltaTime * base.speed);
    next.angularVelocity.copy(base.angularVelocity).addScaledVector(base.angularAcceleration, deltaTime * base.speed);
    next.scalarVelocity.copy(base.scalarVelocity).addScaledVector(base.scalarAcceleration, deltaTime * base.speed);
    next.acceleration.copy(base.acceleration);
    next.angularAcceleration.copy(base.angularAcceleration);
    next.scalarAcceleration.copy(base.scalarAcceleration);
    next.speed = base.speed;
    next.mass = base.mass;
    next.distortionStrength = base.distortionStrength;
    next.color.copy(base.color);
    next.alpha = base.alpha;

    return next;
  }

  private _updateSubSystems() {
    if (
      this.gpuSimulation._isGPUProcessingActive &&
      this.gpuSimulation._gpuBuffers &&
      !this.gpuSimulation._gpuContinuousSourcesReadbackPending &&
      Array.from(this.subSystems).some(
        ([child, options]) => options.emitContinuous && !child.gpuSimulation._canUpdateAsGPUSubSystem(this, options),
      )
    ) {
      this.gpuSimulation._readGPUContinuousSources();
    }
    for (const source of this.emissionRuntime._emissionSources.values()) {
      source.realtime += this.deltaTime * 1000;
      source.time = source.realtime / (Math.max(this.duration, Number.EPSILON) * 1000);
    }
    this.subSystems.forEach((options, subSystem) => {
      if (subSystem.gpuSimulation._canUpdateAsGPUSubSystem(this, options)) {
        subSystem._updateAsGPUSubSystem(this, options, this.deltaTime);
      } else {
        subSystem._updateAsSubSystem(
          [
            ...(this.gpuSimulation._isGPUProcessingActive
              ? this.gpuSimulation._gpuContinuousSourceSnapshots
              : this.particles),
            ...this.emissionRuntime._emissionSources.values(),
          ],
          options,
          this.deltaTime,
        );
      }
    });

    if (
      this.eventRuntime._gpuFrameEventBuffer &&
      ParticleSystem.isWebGPURenderer(this.sceneRenderer) &&
      this.gpuSimulation._hasGPUNativeSubSystemConsumers()
    ) {
      this.gpuSimulation._scheduleGPUEventReadback(this.eventRuntime._gpuFrameEventBuffer, this.sceneRenderer);
    }
  }

  private _updateAsGPUSubSystem(parent: ParticleSystem, options: SubSystemOptions, parentDeltaTime: number): void {
    if (this._destroyed || this._paused) return;
    if (!this._renderer && parent.sceneRenderer) this._renderer = parent.sceneRenderer;
    if (!this._scene && parent.scene) this._scene = parent.scene;
    if (!this._camera && parent.sceneCamera) this._camera = parent.sceneCamera;

    const simulationDistanceSq = this._getSimulationDistanceSq();
    this._cameraDistanceSq = simulationDistanceSq;
    this._updateLODQuality();
    if (!this._isWithinSimulationDistance(simulationDistanceSq)) {
      return;
    }

    const nextDeltaTime = this._scaleDeltaTime(parentDeltaTime);
    this._skipIntermediateRender = this._subSystemParent?._skipIntermediateRender ?? false;
    this.syncRendererParents();
    this.deltaTime = nextDeltaTime;
    if (options.emitContinuous) this._prewarm();
    if (this._playing && options.emitContinuous) this._updateSystemTime();

    this.emissionRuntime._updateEmitterInstances(parent.emissionRuntime._emissionSources.values());
    this.gpuSimulation._gpuSubSystemFrameInput = { parent, options };
    this._processParticles();
    this.gpuSimulation._gpuSubSystemFrameInput = undefined;
    this._updateSubSystems();
    this._handleEndBehavior();
  }

  private _updateAsSubSystem(
    parentParticles: SubSystemSource[],
    options: SubSystemOptions,
    parentDeltaTime: number,
  ): void {
    if (this._destroyed || this._paused) return;

    const simulationDistanceSq = this._getSimulationDistanceSq();
    this._cameraDistanceSq = simulationDistanceSq;
    this._updateLODQuality();
    if (!this._isWithinSimulationDistance(simulationDistanceSq)) {
      return;
    }

    const nextDeltaTime = this._scaleDeltaTime(parentDeltaTime);
    this._skipIntermediateRender = this._subSystemParent?._skipIntermediateRender ?? false;
    this.syncRendererParents();
    this.deltaTime = nextDeltaTime;
    if (options.emitContinuous) this._prewarm();
    if (this._playing && options.emitContinuous) this._updateSystemTime();

    this.emissionRuntime._updateEmitterInstances(parentParticles);
    this._cpuSubSystemFrameActive = true;
    try {
      this._processParticles();
    } finally {
      this._cpuSubSystemFrameActive = false;
    }
    this._updateSubSystems();
    if (options.emitContinuous) this._handleEndBehavior();
  }

  /*
   * CONTROL
   */

  // Start emitting
  /** Starts or restarts emission from time zero; existing particles are retained. */
  public start(children: boolean = true): void {
    const now = Date.now();

    this._playing = true;
    this._paused = false;
    this._ended = false;
    this._elapsedTime = 0;
    this.lastFrame = now;
    this._resetEmitterContextVelocity();

    this.emissionRuntime._clearEmitterInstances();
    this.gpuSimulation._gpuStandaloneEmitterInstances?.reset();
    this.gpuSimulation._gpuContinuousEmitterInstances?.reset();
    this.gpuSimulation._gpuEventEmitterInstances?.reset();
    this.gpuSimulation._gpuEmissionRuns?.reset();

    this.subSystems.forEach((_options, subSystem) => {
      subSystem.start();
    });

    if (children) this._iterateChildren(child => child.start(false));

    this._prewarm();
  }

  /** Freezes emission and simulation while playing; propagates to subsystems and optionally child systems. */
  public pause(children: boolean = true): void {
    if (!this._playing || this._paused) return;
    this._paused = true;

    this.subSystems.forEach((_options, subSystem) => {
      subSystem.pause();
    });

    if (children) this._iterateChildren(child => child.pause(false));
  }

  /** Stops emission and resets prewarm state. clearParticles chooses whether to remove them immediately. */
  public stop(clearParticles: boolean, children: boolean = true): void {
    this._playing = false;
    this._paused = false;
    this._ended = true;
    this._prewarmed = false;
    this._resetEmitterContextVelocity();

    this.subSystems.forEach((_options, subSystem) => {
      // Clear the complete subsystem tree once through this system below.
      subSystem.stop(false);
    });

    if (children) this._iterateChildren(child => child.stop(clearParticles, false));

    this.emissionRuntime._clearEmitterInstances();

    // Registered subsystems are part of this system's particle state, even when
    // ordinary Object3D child propagation is disabled.
    if (clearParticles) this.clearParticles(false);
  }

  /** Stop, clear all CPU/GPU state and timing, then begin a fresh run. */
  public reset(children: boolean = true): void {
    this.renderers.forEach(renderer => renderer.reset());
    this.stop(true, false);
    this.start(false);

    if (children) this._iterateChildren(child => child.reset(false));
  }

  /** Clears particles and renderer contents; optionally includes independent child systems. */
  public clearParticles(children: boolean = true): void {
    const gpuRenderer = ParticleSystem.isWebGPURenderer(this.sceneRenderer) ? this.sceneRenderer : undefined;
    this.gpuSimulation.clear(gpuRenderer);
    this.eventRuntime.clearGPU(gpuRenderer);
    this.frameRuntime.clear(gpuRenderer);
    this.particles.length = 0;
    this.spatialRuntime.clear(gpuRenderer);
    this._processingMode = undefined;
    this.emissionRuntime._stagedBirths.length = 0;
    this._prewarmed = false;

    this.renderers.forEach(renderer => {
      renderer.update(this.particles, this);
      renderer.clear();
    });

    this.subSystems.forEach((_options, subSystem) => {
      subSystem.clearParticles();
    });

    if (children) this._iterateChildren(child => child.clearParticles(false));
  }

  /** Permanently destroys this system and renderer resources; later update or advancement calls do nothing. */
  public destroy(children: boolean = true): void {
    if (this._destroyed) return;

    for (const id of this.emissionRuntime._emissionSources.keys()) this.unregisterEmissionSource(id);
    const gpuRenderer = ParticleSystem.isWebGPURenderer(this.sceneRenderer) ? this.sceneRenderer : undefined;
    this.eventRuntime.disposeJournal(gpuRenderer);
    this._destroyed = true;
    for (const component of [...this.emitters, ...this.modules, ...this.renderers]) component.dispose();
    this.eventRuntime._eventObservers.clear();
    this.stop(true, children);

    this.subSystems.forEach((_options, subSystem) => {
      subSystem.destroy();
    });

    if (children) this._iterateChildren(child => child.destroy(false));

    this.renderers.forEach(renderer => {
      renderer.reset();
      renderer.destroy();
    });
    this.spatialRuntime.dispose(gpuRenderer);

    this.removeFromParent();
    this.cleanup();
    this._materialCopyRegistry?.dispose();
    this._materialCopyRegistry = undefined;
    this.dispatchEvent({ type: 'destroyed' } as unknown as Parameters<typeof this.dispatchEvent>[0]);
  }

  /*
   * ACCESSING
   */

  /** Adds a particle while preserving stable GPU slots and the configured capacity policy. */
  public addParticle(particle: Particle, particles: Particle[] = this.particles): boolean {
    particle.setEventOwner(this);
    if (this.maxParticles <= 0) return false;

    if (!this.gpuSimulation._usesGPUStableParticleSlots() || particles !== this.particles) {
      particles.push(particle);
      return true;
    }

    const deadIndex = particles.findIndex(candidate => !candidate.alive);
    if (deadIndex !== -1) {
      particles[deadIndex] = particle;
      this.gpuSimulation._gpuDirtyParticleSlots.add(deadIndex);
      return true;
    }

    if (particles.length >= this.maxParticles) {
      if (this.maxCullingMode === MaxCulling.New) return false;

      if (particles[0]?.alive) {
        particles[0].alive = false;
        this._notifyParticleDeath(particles[0]);
      }
      particles[0] = particle;
      this.gpuSimulation._gpuDirtyParticleSlots.add(0);
      return true;
    }

    particles.push(particle);
    this.gpuSimulation._gpuDirtyParticleSlots.add(particles.length - 1);
    return true;
  }

  /** Attaches an emitter and runs its setup hook. */
  public addEmitter(emitter: Emitter): this {
    this.emitters.push(emitter);
    this._populationEstimates.clear();
    emitter.setup(this);

    return this;
  }

  /** Removes an emitter from emission and clears its association with the system. */
  public removeEmitter(emitter: Emitter): this {
    const index = this.emitters.indexOf(emitter);

    if (index !== -1) {
      emitter.dispose();
      this.emitters.splice(index, 1);
      this._populationEstimates.clear();
      this.remove(emitter.source);
    }

    return this;
  }

  /** Adds a modifier to the composition; execution order follows numeric priority. */
  public addModule(module: Module): this {
    this.modules.push(module);

    return this;
  }

  /** Removes a modifier and runs its cleanup hook. */
  public removeModule(module: Module): this {
    const index = this.modules.indexOf(module);

    if (index !== -1) {
      module.dispose();
      this.modules.splice(index, 1);
      module.cleanup();
    }

    return this;
  }

  /** Adds an explicit generic effect; avoid adding the same effect more than once. */
  public addSpatialEffect(spatialEffect: SpatialEffect): this {
    this.spatialEffects.push(spatialEffect);

    return this;
  }

  /** Removes an explicitly attached effect without destroying its scene object. */
  public removeSpatialEffect(spatialEffect: SpatialEffect): this {
    const index = this.spatialEffects.indexOf(spatialEffect);

    if (index !== -1) {
      this.spatialEffects.splice(index, 1);
    }

    return this;
  }

  /** Adds a view of the particle population and runs renderer setup. */
  public addRenderer(renderer: Renderer): this {
    this.renderers.push(renderer);
    renderer.setup(this);
    this.syncRendererParents();

    return this;
  }

  /** Detaches a renderer and destroys its owned rendering resources. */
  public removeRenderer(renderer: Renderer): this {
    const index = this.renderers.indexOf(renderer);

    if (index !== -1) {
      renderer.dispose();
      this.renderers.splice(index, 1);
      renderer.reset();
      renderer.destroy();
    }

    return this;
  }

  /** Registers an owned renderer object under the appropriate local/world render root. */
  public addRendererObject(object: THREE.Object3D): void {
    object.userData[PARTICLE_RENDERER_OBJECT_KEY] = true;
    this._rendererObjects.add(object);
    this.getRendererParent().add(object);
  }

  /** Detaches a renderer-owned object from this particle system. */
  public removeRendererObject(object: THREE.Object3D): void {
    this._rendererObjects.delete(object);
    object.removeFromParent();
  }

  /** Registers a persistent CPU-managed subsystem emission origin. */
  public registerEmissionSource(data: EmissionSourceData): EmissionSource {
    if (this._destroyed) throw new Error('Cannot register an emission source on a destroyed system.');
    const source = new EmissionSource(this, data);
    this.emissionRuntime._emissionSources.set(source.id, source);
    this._dispatchSourceEvent(source, 'spawn');
    return source;
  }

  /** Updates CPU attributes only; repeated updates coalesce at the next frame. */
  public updateSource(id: string, changes: Partial<EmissionSourceData>): void {
    this.emissionRuntime._emissionSources.get(id)?.apply(changes);
  }

  /** Dispatches death once and releases continuous context state; event runs keep their snapshots. */
  public unregisterEmissionSource(id: string): void {
    const source = this.emissionRuntime._emissionSources.get(id);
    if (!source) return;
    this.emissionRuntime._emissionSources.delete(id);
    source.alive = false;
    this._dispatchSourceEvent(source, 'death');
    this.subSystems.forEach((_options, child) => child.emitters.forEach(emitter => emitter.clearContext(id, child)));
  }

  /** Targets either a registered source or a live simulated particle by its stable ID. */
  public emitEvent(event: string, data?: unknown): void;
  public emitEvent(id: string, event: string, data?: unknown): void;
  public emitEvent(id: string, event?: unknown, data?: unknown): void {
    const targeted =
      arguments.length >= 3 ||
      (typeof event === 'string' &&
        (id.startsWith('source:') || id.startsWith('gpu:') || this.particles.some(particle => particle.id === id)));
    if (!targeted) {
      this.eventRuntime._publishSimulationEvent(id, event);
      return;
    }
    if (typeof event !== 'string') throw new TypeError('A targeted event requires an event name.');
    const registered = this.emissionRuntime._emissionSources.get(id);
    if (registered) {
      this._dispatchSourceEvent(registered, event, data);
      return;
    }
    const index = this.particles.findIndex(p => p.id === id && p.alive);
    if (!this.gpuSimulation._isGPUProcessingActive) {
      if (index >= 0) this._dispatchSourceEvent(this.particles[index], event, data);
      return;
    }
    const gpuID = /^gpu:(\d+):(\d+)$/.exec(id);
    const slot = gpuID ? Number(gpuID[1]) : index;
    const generation = gpuID ? Number(gpuID[2]) : this.gpuSimulation._gpuParticleSlotGenerations[index];
    if (
      this.gpuSimulation._gpuBuffers &&
      slot >= 0 &&
      slot < this.gpuSimulation._gpuBuffers.capacity &&
      generation > 0
    ) {
      this.eventRuntime._pendingGPUEvents.push({ slot, generation, event, data });
    }
  }

  private _systemEmissionOrigin(): SubSystemSource {
    return {
      id: `system:${this.uuid}`,
      position: new THREE.Vector3(),
      rotation: new THREE.Vector3(),
      scale: new THREE.Vector3(1, 1, 1),
      velocity: new THREE.Vector3(),
      color: new THREE.Color(1, 1, 1),
      alpha: 1,
      mass: 1,
      distortionStrength: 1,
      lifetime: Infinity,
      time: 0,
      realtime: 0,
      alive: true,
    };
  }

  private _subscribes(options: SubSystemOptions, event: string): boolean {
    return (
      (event === 'spawn' && options.emitOnSpawn) ||
      (event === 'death' && options.emitOnDeath) ||
      (event === 'collision' && options.emitOnCollision) ||
      eventNames(options.onEvent).includes(event)
    );
  }

  private _dispatchSourceEvent(source: SubSystemSource, event: string, data?: unknown, skipGPUConsumers = false): void {
    this.eventRuntime._publishSimulationEvent(event, data, source, skipGPUConsumers);
  }

  private _discoverEventTypes(): void {
    // IDs persist for the lifetime of the system: dispatch never changes this map.
    for (const options of this.subSystems.values()) {
      for (const name of eventNames(options.onEvent)) {
        if (this.eventRuntime._eventTypes.has(name)) continue;
        if (this.eventRuntime._eventTypes.size >= 32)
          throw new Error('RZMPS supports at most 32 event types (3 built-in + 29 custom) per parent system.');
        this.eventRuntime._eventTypes.set(name, this.eventRuntime._eventTypes.size + 1);
      }
    }
  }

  /** Adds a system to this system as a subsystem, using this system's particles as its emission points. */
  public addSubSystem(subSystem: ParticleSystem, options: Partial<SubSystemOptions> = {}): this {
    // No adding recursive self
    if (subSystem === this) return this;
    if (new Set([...this.eventRuntime._eventTypes.keys(), ...eventNames(options.onEvent)]).size > 32) {
      throw new Error('RZMPS supports at most 32 event types (3 built-in + 29 custom) per parent system.');
    }

    // Replace existing parent
    if (subSystem._subSystemParent && subSystem._subSystemParent !== this) {
      subSystem._subSystemParent.removeSubSystem(subSystem);
    }

    this._subSystemOverrides.set(subSystem, { ...options });
    const view = new Proxy({} as SubSystemOptions, {
      get: (_target, key) => {
        const values = subSystem.emitters.map(emitter =>
          overrideEmitterOptions(
            { ...emitter.emission, eventScope: emitter.eventScope },
            this._subSystemOverrides.get(subSystem),
            true,
          ),
        );
        const base = values[0] ?? overrideEmitterOptions({}, this._subSystemOverrides.get(subSystem), true);
        if (['emitContinuous', 'emitOnSpawn', 'emitOnDeath', 'emitOnCollision'].includes(String(key))) {
          return values.some(value => value[key as keyof SubSystemOptions]);
        }
        if (key === 'onEvent') {
          const merged = Object.assign(
            {},
            ...values.map(value =>
              Array.isArray(value.onEvent)
                ? Object.fromEntries(value.onEvent.map(name => [name, true]))
                : value.onEvent,
            ),
          );
          return Object.keys(merged).length ? merged : undefined;
        }
        return base[key as keyof SubSystemOptions];
      },
      set: (_target, key, value) => {
        Object.assign(this._subSystemOverrides.get(subSystem)!, { [key]: value });
        return true;
      },
      ownKeys: () => [
        ...new Set([
          ...Reflect.ownKeys(overrideEmitterOptions({}, {}, true)),
          'onEvent',
          'tags',
          'events',
          'eventScope',
        ]),
      ],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    });
    this.subSystems.set(subSystem, view);

    this._discoverEventTypes();
    subSystem._subSystemParent = this;
    if (!subSystem.frameRuntime._simulationSpaceExplicit) {
      subSystem.simulationSpace = this.simulationSpace;
      subSystem.frameRuntime._simulationSpaceExplicit = false;
    }

    // Identity local transform makes the subsystem share this system's space.
    subSystem.position.set(0, 0, 0);
    subSystem.rotation.set(0, 0, 0);
    subSystem.scale.set(1, 1, 1);
    this.add(subSystem);
    this._reconcileEventReceivers();

    return this;
  }

  /** Detaches a subsystem without destroying it; its simulation can then be advanced independently. */
  public removeSubSystem(subSystem: ParticleSystem): this {
    if (!this.subSystems.delete(subSystem)) return this;
    for (const source of this.emissionRuntime._emissionSources.values()) {
      subSystem.emitters.forEach(emitter => emitter.clearContext(source.id, subSystem));
    }

    this._subSystemOverrides.delete(subSystem);
    subSystem._subSystemParent = undefined;
    if (subSystem.parent === this) this.remove(subSystem);
    this._reconcileEventReceivers();
    subSystem._reconcileEventReceivers();
    return this;
  }

  /*
   * LISTENERS
   */

  /** Registers a synchronous listener for particle expiry; returns the system for composition. */
  public onDeath(listener: ParticleListener): this {
    this.eventRuntime._deathListeners.push(listener);
    return this;
  }

  /** Unregisters a previously attached death listener. */
  public removeDeathListener(listener: ParticleListener): this {
    this.eventRuntime._deathListeners = this.eventRuntime._deathListeners.filter(value => value !== listener);
    return this;
  }

  /** Registers a synchronous listener for emitter births. */
  public onSpawn(listener: ParticleListener): this {
    this.eventRuntime._spawnListeners.push(listener);
    return this;
  }

  /** Unregisters a previously attached spawn listener. */
  public removeSpawnListener(listener: ParticleListener): this {
    this.eventRuntime._spawnListeners = this.eventRuntime._spawnListeners.filter(value => value !== listener);
    return this;
  }

  /** Registers a synchronous listener for collisions reported by a Collision module. */
  public onCollision(listener: CollisionListener): this {
    this.eventRuntime._collisionListeners.push(listener);
    return this;
  }

  /** Unregisters a previously attached collision listener. */
  public removeCollisionListener(listener: CollisionListener): this {
    this.eventRuntime._collisionListeners = this.eventRuntime._collisionListeners.filter(value => value !== listener);
    return this;
  }

  // Called by Collision after a hit is found.
  /** Reports a contact to listeners and starts eligible collision-triggered subsystem emissions. */
  public notifyCollision(particle: Particle, collision: CollisionHit): void {
    this.eventRuntime._collisionListeners.forEach(listener => listener(particle, collision));

    this._dispatchSourceEvent(particle, 'collision', collision);
  }

  private _notifyDeath(particle: Particle, skipGPUConsumers = false): void {
    this.eventRuntime._deathListeners.forEach(listener => listener(particle));
    this._dispatchSourceEvent(particle, 'death', undefined, skipGPUConsumers);
  }

  private readonly _initializedParticles = new WeakSet<Particle>();

  /** @internal Coordinates configured module order, independently of deferred event dispatch. */
  initializeParticle(particle: Particle, context: ParticleInitializationContext): void {
    if (this._initializedParticles.has(particle)) return;

    const initializers = this.modules
      .flatMap(module => module.withDependents())
      .filter(module => module.initializeParticle !== undefined);
    if (!initializers.length) return;

    this._initializedParticles.add(particle);
    let initializationContext: ParticleInitializationContext | undefined;

    // Resolve the birth frame once, only if a selected initializer needs it.
    for (const module of initializers) {
      if (module.tags && !tagsIntersect(module.tags, particle.tags ?? [])) continue;

      initializationContext ??= {
        ...context,
        birthToWorld: context.birthToWorld ?? this.getSimulationToWorldMatrix(),
      };
      module.initializeParticle!(particle, initializationContext);
    }

    // No-op and unmatched modules must not allocate a redundant permanent-state snapshot.
    if (initializationContext) particle.cache();
  }

  /** @internal Called by native birth graphs after attributes are assigned, before spawn events. */
  initializeParticleGPU(particle: GPUParticleLike, context: GPUParticleInitializationContext): void {
    resetInitializationAttributesGPU(particle);
    const initializers = this.modules
      .flatMap(module => module.withDependents())
      .filter(module => module.initializeParticleGPU !== undefined);
    if (!initializers.length) return;

    this.gpuSimulation._configureParticleGPU(particle, context);
    for (const module of initializers) {
      const mask = this.getGPURendererTagMask(module.tags);
      if (module.tags) {
        If(particle.tagMask.bitAnd(uint(mask ?? 0)).notEqual(0), () => {
          module.initializeParticleGPU!(particle, context);
        });
      } else module.initializeParticleGPU!(particle, context);
    }
  }

  private _notifySpawn(particle: Particle): void {
    particle.setEventOwner(this);
    this.eventRuntime._spawnListeners.forEach(listener => listener(particle));
    this._dispatchSourceEvent(particle, 'spawn');
  }

  private _dispatchGPUSpawnEvent(particle: Particle): void {
    this.eventRuntime._spawnListeners.forEach(listener => listener(particle));
    this._dispatchSourceEvent(particle, 'spawn', undefined, true);
  }

  private _dispatchGPUCollisionEvent(particle: Particle, collision: CollisionHit): void {
    this.modules
      .flatMap(module => module.withDependents())
      .filter((module): module is Collision => module instanceof Collision)
      .forEach(module => module.notifyGPUCollision(particle, collision));
    this.eventRuntime._collisionListeners.forEach(listener => listener(particle, collision));
    this._dispatchSourceEvent(particle, 'collision', collision, true);
  }

  private cleanup(): void {
    this.gpuSimulation._disposeGPUComputeCaches();

    this.modules.flatMap(module => module.withDependents()).forEach(module => module.cleanup());

    this.renderers.forEach(renderer => renderer.clear());

    this._worldRendererRoot.removeFromParent();
  }

  /** @internal Transient inputs for standalone emitter executions. */
  getEmitterContext(): Partial<EmissionContext> {
    const context = {
      time: this.duration === 0 ? 1 : this._elapsedTime / this.duration,
      elapsedTime: this._elapsedTime,
      position: this.position,
      velocity:
        this.inheritVelocity > 0
          ? this._emitterContextVelocity.clone().multiplyScalar(this.inheritVelocity)
          : undefined,
    };

    this.updateWorldMatrix(true, false);
    const transform = this.getSimulationToWorldMatrix().invert().multiply(this.matrixWorld);
    if ([SimulationSpace.Local, SimulationSpace.Source].includes(this.simulationSpace)) return context;

    return {
      ...context,
      transform,
      position: new THREE.Vector3().setFromMatrixPosition(transform),
    };
  }

  private _updateEmitterContextVelocity(): void {
    this.updateWorldMatrix(true, false);
    this._emitterContextWorldPosition.setFromMatrixPosition(this.matrixWorld);

    if (!this._hasEmitterContextPreviousWorldPosition || this.deltaTime <= 0) {
      this._emitterContextVelocity.set(0, 0, 0);
      this._emitterContextPreviousWorldPosition.copy(this._emitterContextWorldPosition);
      this._hasEmitterContextPreviousWorldPosition = true;
      return;
    }

    this._emitterContextVelocity
      .copy(this._emitterContextWorldPosition)
      .sub(this._emitterContextPreviousWorldPosition)
      .divideScalar(this.deltaTime);

    this._emitterContextPreviousWorldPosition.copy(this._emitterContextWorldPosition);

    if (this.simulationSpace === SimulationSpace.World) return;

    const worldQuaternion = new THREE.Quaternion();
    this.getSimulationWorldQuaternion(worldQuaternion).invert();
    this._emitterContextVelocity.applyQuaternion(worldQuaternion);
  }

  private _resetEmitterContextVelocity(): void {
    this._emitterContextVelocity.set(0, 0, 0);
    this._hasEmitterContextPreviousWorldPosition = false;
  }

  private _updateSystemTime(): void {
    this._elapsedTime += this.deltaTime;

    if (this.looping) {
      if (this.duration > 0 && this._elapsedTime >= this.duration) {
        const wrap = Math.floor(this._elapsedTime / this.duration) * this.duration;
        this._elapsedTime -= wrap;
        if (this._skippedTime > 0) {
          this._skippedClockWrap += wrap;
          this.emitters.forEach(emitter => emitter.clearContext('__default', this));
          return;
        }
        // The system cycle owns ordinary emission only; source/event contexts have independent clocks.
        this.emitters.forEach(emitter => emitter.clearContext('__default', this));
        this.gpuSimulation._gpuStandaloneEmitterInstances?.reset();
      }
      return;
    }

    // Importantly, this isn't allowed to "end" if it has a parent
    // If the parent is alive, this must stay alive
    if (this._elapsedTime >= this.duration && !this.isSubSystem) {
      this._elapsedTime = this.duration;
      this._playing = false;
      this._ended = true;
    }
  }

  private _prewarm(): void {
    if (!this.prewarm || this._prewarmed || !this._playing || this._paused) return;

    this._prewarmed = true;

    if (this.duration <= 0) return;

    // Make sure live cubemap isn't udpated during this phase
    const lastUseLiveCubemap = this.useLiveCubemap;
    this.useLiveCubemap = false;

    const fps = Number.isFinite(this.prewarmFPS) && this.prewarmFPS > 0 ? this.prewarmFPS : 24;
    const frameDuration = 1 / fps;
    const previousDeltaTime = this.deltaTime;
    const previousGPUProcessing = this._gpuProcessing;
    const canPrewarmOnCPU =
      previousGPUProcessing &&
      this.modules
        .flatMap(module => module.withDependents())
        .every(module => module._modify !== Module.CPU_UNSUPPORTED);
    if (canPrewarmOnCPU) {
      // A synchronous prewarm loop cannot await hundreds of GPU dispatches safely.
      // Build authoritative CPU state, then let the next GPU frame upload it once.
      this._gpuProcessing = false;
      this._processingMode = 'cpu';
    }
    let remaining = this.duration;

    this.emissionRuntime._clearEmitterInstances();
    this._elapsedTime = 0;
    this._isPrewarming = true;

    try {
      while (remaining > 0 && !this._destroyed) {
        this.deltaTime = Math.min(frameDuration, remaining);

        this._advanceSimulationStep(false);

        remaining -= this.deltaTime;
      }
    } finally {
      this._isPrewarming = false;
      this.useLiveCubemap = lastUseLiveCubemap;
      this._gpuProcessing = previousGPUProcessing;
      if (canPrewarmOnCPU) this._processingMode = undefined;
      this.deltaTime = previousDeltaTime;
      this.lastFrame = Date.now();
    }
  }

  private _iterateChildren(callback: (child: ParticleSystem) => void): void {
    const particleSystems: ParticleSystem[] = [];

    this.traverse(child => {
      if (child === this || !(child instanceof ParticleSystem) || child.isSubSystem) return;

      particleSystems.push(child);
    });

    // Pass false in callbacks since the collected list already includes all descendants.
    particleSystems.forEach(callback);
  }

  private _getSimulationDistanceSq(): number {
    if (!this.sceneCamera) return Number.MAX_SAFE_INTEGER;

    this.updateWorldMatrix(true, false);
    this.sceneCamera.updateWorldMatrix(true, false);

    this.getWorldPosition(this._simulationDistanceWorldPos);
    this.sceneCamera.getWorldPosition(this._simulationDistanceCameraWorldPos);

    return this._simulationDistanceWorldPos.distanceToSquared(this._simulationDistanceCameraWorldPos);
  }

  private _isWithinSimulationDistance(distanceSq: number): boolean {
    if (this.simulationDistance <= 0) return true;

    return distanceSq <= this.simulationDistance ** 2;
  }

  private _handleEndBehavior(): void {
    if (!this._ended || this.looping || this._destroyed) return;

    if (this.endBehavior === EndBehavior.DestroyImmediate) {
      this.destroy();
    } else if (this.endBehavior === EndBehavior.Destroy && this.particles.length === 0) {
      this.destroy();
    }
  }

  private getRendererParent(): THREE.Object3D {
    if (![SimulationSpace.World, SimulationSpace.Transform].includes(this.simulationSpace)) return this;
    return this._worldRendererRoot;
  }

  private syncRendererParents(): void {
    const worldRendererParent = this.getWorldRendererParent();

    if (this.simulationSpace === SimulationSpace.World || this.simulationSpace === SimulationSpace.Transform) {
      if (worldRendererParent && this._worldRendererRoot.parent !== worldRendererParent) {
        worldRendererParent.add(this._worldRendererRoot);
      }
    } else if (this._worldRendererRoot.parent) {
      this._worldRendererRoot.removeFromParent();
    }

    if (this.simulationSpace === SimulationSpace.Transform || this.simulationSpace === SimulationSpace.World) {
      worldRendererParent?.updateWorldMatrix(true, false);
      this._worldRendererRoot.matrixAutoUpdate = false;
      this._worldRendererRoot.matrix
        .copy(worldRendererParent?.matrixWorld ?? new THREE.Matrix4())
        .invert()
        .multiply(this.getSimulationToWorldMatrix());
      this._worldRendererRoot.matrixWorldNeedsUpdate = true;
    }
    const parent = this.getRendererParent();
    this._rendererObjects.forEach(object => {
      if (object.parent !== parent) parent.add(object);
    });
  }

  private getWorldRendererParent(): THREE.Object3D | undefined {
    let parent = this.parent;

    while (parent instanceof ParticleSystem) {
      parent = parent.parent;
    }

    return parent ?? undefined;
  }

  private localDirectionToWorld(vector: THREE.Vector3): void {
    vector.applyMatrix3(this._directionNormalMatrix.getNormalMatrix(this.getSimulationToWorldMatrix()));
  }

  // Require a compute-capable WebGPU backend before using storage buffers.
  private static isWebGPURenderer(renderer: unknown): renderer is WebGPURenderer {
    return isWebGPURenderer(renderer);
  }
}

export default ParticleSystem;
