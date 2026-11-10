import GPUSubSystemPredicates from '../emission/gpu/SubSystemPredicates';
import GlobalSettings from '../core/GlobalSettings';
import * as THREE from 'three';
import {
  bitcast,
  Break,
  Continue,
  float,
  Fn,
  hash,
  If,
  instanceIndex,
  inverse,
  Loop,
  mat3,
  mat4,
  mix,
  pow,
  uint,
  uniform,
  uvec4,
  vec3,
  vec4,
} from 'three/tsl';
import { WebGPURenderer, type ComputeNode, type Node } from 'three/webgpu';
import type { CollisionHit } from '../collision/collision.types';
import Module from '../core/Module';
import Particle from '../core/Particle';
import type ParticleSystem from '../core/ParticleSystem';
import type { SubSystemOptions } from '../core/ParticleSystem';
import { type SubSystemSource } from '../emission/EmissionSource';
import Emitter from '../emission/Emitter';
import { GPUEmissionRunBufferState } from '../emission/gpu/Emission';
import { GPUEmitterInstanceBufferState } from '../emission/gpu/EmitterInstanceBuffer';
import overrideEmitterOptions, { subscribes } from '../emission/options.utils';
import { MaxCulling } from '../enums/MaxCulling';
import { SimulationSpace } from '../enums/SimulationSpace';
import EventReceiver from '../events/EventReceiver';
import { cpuEventHandler, eventNames, type GPUEmissionContext } from '../events/events.utils';
import { SharedGPUEventBatch } from '../events/gpu/EventBatch';
import type { GPUEventReadbackBatch } from '../events/gpu/EventBuffer';
import { GPUEventBufferState, GPUEventType } from '../events/gpu/EventBuffer';
import type { GPUComputeCache, GPUComputeListCache, GPUUniformNode } from '../utils/gpu/computeCache.types';
import { isWebGPURenderer } from '../utils/gpu/isWebGPURenderer';
import { nextPowerOfTwo } from '../utils/gpu/storage.utils';
import Collision from '../modules/Collision';
import { GPUAllocationBufferState, type GPUAllocationDiagnostics } from '../simulation/gpu/AllocationBuffer';
import {
  createEmptyGPUParticleBufferState,
  createGPUParticleBufferState,
  createGPUParticleRenderBufferState,
  type GPUParticleBufferState,
  type GPUParticleLike,
  type GPUParticleRenderBufferState,
  type GPUParticleUpdateContext,
} from '../simulation/gpu/Particle';
import {
  GPUSelectiveReadbackState,
  type GPUParticleReadbackField,
  type GPUSelectiveReadbackRequest,
  type GPUSelectiveReadbackResult,
} from '../simulation/gpu/SelectiveReadback';
import { rotateFromYGPU } from './gpu/transforms.utils';
import { matrixColumnGPU, particleFrameGPU } from './simulationFrame.utils';
import {
  GPUSpatialEffectRegistry,
  isBatchableEffect,
  type GPUSpatialEffectRecord,
} from '../spatial/effects/gpu/SpatialEffectRegistry';
import ParticleSpatialGrid from '../spatial/structures/ParticleSpatialGrid';
import SpatialEffect from '../spatial/effects/SpatialEffect';
import type { Tag } from '../types/tag.types';
import type { DynamicValue } from '../values/dynamicValue.types';
import { GPUDynamicParameterStore } from '../values/evaluateDynamicGPU';
interface GPUSubSystemFrameInput {
  parent: ParticleSystem;
  options: SubSystemOptions;
}
interface GPUSlotIdentity {
  particle: Particle;
  generation: number;
}
interface GPUSelectiveReadbackSlot {
  state: GPUSelectiveReadbackState;
  pending: boolean;
}
export interface GPUSimulationExecution {
  deltaTime(): number;
  elapsedTime(): number;
  skippedTime(): number;
  skippedClockWrap(): number;
  skipRender(): boolean;
  nativeEmission(): boolean;
  eventRoot(): ParticleSystem;
  sharedEvents(): boolean;
  journal(renderer: WebGPURenderer): GPUEventBufferState;
  emitterEventNames(emitter: Emitter): string[];
  dispatchSourceEvent(source: SubSystemSource, event: string, data?: unknown, skipGPUConsumers?: boolean): void;
  spawnEvent(particle: Particle): void;
  collisionEvent(particle: Particle, collision: CollisionHit): void;
  particleDeath(particle: Particle, fromGPUEvent?: boolean): void;
  notifyDeath(particle: Particle): void;
}

/** Owns GPU simulation storage, compute graphs, synchronization and their lifecycle.
 * The public system supplies configuration; narrow callbacks coordinate time and event delivery.
 */
export default class GPUSimulation {
  constructor(
    readonly system: ParticleSystem,
    readonly execution: GPUSimulationExecution,
  ) {}
  _gpuLODCull?: { buffers: GPUParticleBufferState; count: number; version: number; node: ComputeNode };

  readonly _gpuLODQuality = uniform(1, 'float');

  readonly _gpuParentToSimulationNode = uniform(new THREE.Matrix4(), 'mat4');

  readonly _gpuEmissionFrameNode = uniform(new THREE.Matrix4(), 'mat4');

  _gpuBuffers?: GPUParticleBufferState;

  _gpuRenderOutputBuffers?: GPUParticleRenderBufferState;

  _gpuSpatialRegistry?: GPUSpatialEffectRegistry;

  readonly _gpuSelectiveReadbacks: GPUSelectiveReadbackSlot[] = [];

  _gpuSelectiveReadbackOverflowCount = 0;

  _gpuSelectiveReadbackBytes = 0;

  _gpuSelectiveReadbackLatencyMs = 0;

  _gpuAllocationBuffer?: GPUAllocationBufferState;

  _gpuAllocationDiagnostics?: GPUAllocationDiagnostics;

  _gpuAllocationReadbackPending = false;

  _gpuStandaloneEmitterInstances?: GPUEmitterInstanceBufferState;

  _gpuContinuousEmitterInstances?: GPUEmitterInstanceBufferState;

  _gpuEventEmitterInstances?: GPUEmitterInstanceBufferState;

  _gpuEmissionRuns?: GPUEmissionRunBufferState;

  _gpuSubSystemFrameInput?: GPUSubSystemFrameInput;

  _gpuContinuousSourcesReadbackPending = false;

  _gpuContinuousSourceSnapshots: Particle[] = [];

  readonly _gpuParticleSlotIds: Array<string | undefined> = [];

  readonly _gpuParticleSlotGenerations: number[] = [];

  readonly _gpuParticleSlotIdentities = new Map<string, GPUSlotIdentity>();

  readonly _gpuTagRegistry = new Map<Tag, number>();

  _gpuTagOverflow = false;

  _gpuReadbackPending = false;

  _gpuLifecycleGeneration = 0;

  _gpuReadbacksInFlight = 0;

  _gpuReadbackSequence = 0;

  _gpuCPUMirrorStale = false;

  readonly _gpuDirtyParticleSlots = new Set<number>();

  _gpuDebugFrame = 0;

  _gpuDebugActiveFrame: number | undefined;

  _gpuPipelineBuildCount = 0;

  _gpuResourceBuildCount = 0;

  readonly _gpuDeltaTimeNode = uniform(0, 'float').setName('rzmpsDeltaTime') as unknown as GPUUniformNode<
    number,
    'float'
  >;

  readonly _gpuElapsedTimeNode = uniform(0, 'float').setName('rzmpsElapsedTime') as unknown as GPUUniformNode<
    number,
    'float'
  >;

  readonly _gpuDurationNode = uniform(1, 'float').setName('rzmpsDuration') as unknown as GPUUniformNode<
    number,
    'float'
  >;

  readonly _gpuGravityNode = uniform(new THREE.Vector3(), 'vec3').setName('rzmpsGravity') as unknown as GPUUniformNode<
    THREE.Vector3,
    'vec3'
  >;

  readonly _gpuEmitterPositionNode = uniform(new THREE.Vector3(), 'vec3').setName(
    'rzmpsEmitterPosition',
  ) as unknown as GPUUniformNode<THREE.Vector3, 'vec3'>;

  readonly _gpuSimulationToWorldNode = uniform(new THREE.Matrix4(), 'mat4').setName(
    'rzmpsSimulationToWorld',
  ) as unknown as GPUUniformNode<THREE.Matrix4, 'mat4'>;

  readonly _gpuWorldToSimulationNode = uniform(new THREE.Matrix4(), 'mat4').setName(
    'rzmpsWorldToSimulation',
  ) as unknown as GPUUniformNode<THREE.Matrix4, 'mat4'>;

  _gpuEmissionComputeCache?: GPUComputeListCache;

  _gpuOldEmissionComputeCache?: GPUComputeListCache;

  _gpuOldSelectionComputeCache?: GPUComputeListCache;

  _gpuOldDeathEventComputeCache?: GPUComputeCache;

  _gpuAllocationSnapshotComputeCache?: GPUComputeCache;

  _gpuSpawnEventComputeCache?: GPUComputeCache;

  _gpuEmissionPrepareComputeCache?: GPUComputeListCache;

  _gpuEmissionFinalizeComputeCache?: GPUComputeListCache;

  _gpuContinuousSubSystemComputeCache?: GPUComputeListCache;

  _gpuEventSubSystemComputeCache?: GPUComputeListCache;

  _gpuSimulationComputeCache?: GPUComputeCache;

  readonly _gpuSimulationComputeCaches = new Map<string, GPUComputeCache>();

  readonly _gpuModifierComputeCaches = new Map<string, GPUComputeCache>();

  _gpuRenderOutputComputeCache?: GPUComputeCache;

  readonly _gpuObjectIds = new WeakMap<object, number>();

  private readonly subSystemPredicates = new GPUSubSystemPredicates();

  readonly _gpuParameters = new GPUDynamicParameterStore();

  readonly _gpuSkippedTimeNode = uniform(0);

  readonly _gpuSkippedClockWrapNode = uniform(0);

  _gpuSkipTimeCompute?: { buffers: GPUParticleBufferState; version: number; count: number; node: ComputeNode };

  _stagedBirthBuffers?: GPUParticleBufferState;

  _stagedBirthCompute?: GPUComputeListCache;

  readonly _stagedBirthCount = uniform(0, 'uint');

  _nextGPUModifierId = 1;

  _latestAppliedGPUReadbackSequence = 0;

  _lastGPUAllocationReadbackTime = Number.NEGATIVE_INFINITY;

  _lastGPUReadbackRequestTime = Number.NEGATIVE_INFINITY;

  _isGPUProcessingActive = false;

  _processParticlesGPU(modules: Module[], spatialEffects: SpatialEffect[]): void {
    const sceneRenderer = this.system.sceneRenderer;
    if (!isWebGPURenderer(sceneRenderer)) return;
    this._flushTargetedGPUEvents();
    const lifecycleGeneration = this._gpuLifecycleGeneration;
    const gpuSpatialEffects = spatialEffects.filter(spatialEffect => spatialEffect.supportsGPU);

    const debugFrame = this._beginGPUDebugFrame(modules);
    const hasPendingReadback = this._gpuReadbackPending;
    const preserveGPUState = hasPendingReadback || this._gpuCPUMirrorStale;

    if (preserveGPUState) {
      this._logGPUDebug('CPU mirror stale; preserving GPU state', {
        inFlight: this._gpuReadbacksInFlight,
        particleCount: this.system.particles.length,
        gpuCount: this._gpuBuffers?.count,
        sample: this._sampleGPUParticles(this.system.particles),
      });
    } else {
      this._logGPUDebug('before restore', {
        particleCount: this.system.particles.length,
        sample: this._sampleGPUParticles(this.system.particles),
      });
      this.system.particles.forEach(particle => {
        if (particle.alive) particle.restore();
      });
      this._markExpiredGPUParticleSlots();
      this._logGPUDebug('after restore + death sync', {
        particleCount: this.system.particles.length,
        sample: this._sampleGPUParticles(this.system.particles),
      });
    }

    this._isGPUProcessingActive = true;

    modules.forEach(module => module.beginExecution(this.system, this.execution.deltaTime()));
    modules.forEach(module => module.prepare(module.executionContext!));

    this._logGPUDebug('prepared modules', {
      modifiers: this._describeGPUModules(modules),
    });

    const gpuNativeEmission = this.execution.nativeEmission();

    if (!this._gpuBuffers) {
      this._gpuResourceBuildCount += 1;
      this._gpuBuffers = createGPUParticleBufferState(
        this.system.particles,
        this._getInitialGPUBufferCapacity(),
        particle => this._getParticleGPUTagMask(particle),
        (particle, index) => this._getGPUParticleSlotGeneration(particle, index),
      );
    } else if (preserveGPUState) {
      this._uploadDirtyGPUParticleSlots(this._gpuBuffers);
    } else {
      this._gpuBuffers.upload(
        this.system.particles,
        particle => this._getParticleGPUTagMask(particle),
        (particle, index) => this._getGPUParticleSlotGeneration(particle, index),
      );
    }
    if (gpuNativeEmission) {
      const estimatedCapacity = this._getInitialGPUBufferCapacity();
      if (estimatedCapacity > this._gpuBuffers.capacity && this._gpuBuffers.grow(sceneRenderer, estimatedCapacity)) {
        this._gpuRenderOutputBuffers?.dispose(sceneRenderer);
        this._gpuRenderOutputBuffers = undefined;
        this._gpuAllocationBuffer = undefined;
        this._disposeGPUComputeCaches();
      }
      this._gpuBuffers.ensureCount(this._gpuBuffers.capacity);
    }
    const mainBufferInitialization = this._gpuBuffers.initialize(sceneRenderer);
    this._logGPUDebug('uploaded main buffer', {
      count: this._gpuBuffers.count,
      capacity: this._gpuBuffers.capacity,
      initialization: mainBufferInitialization,
      sample: this._sampleGPUParticles(this.system.particles),
    });

    const lodBuffers = this._gpuBuffers;
    if (
      !this._gpuLODCull ||
      this._gpuLODCull.buffers !== lodBuffers ||
      this._gpuLODCull.version !== lodBuffers.version ||
      this._gpuLODCull.count !== lodBuffers.count
    ) {
      this._gpuLODCull?.node.dispose();
      const node = Fn(() => {
        const state = lodBuffers.storage.createStateNode();
        If(float(state.w).div(4294967296).greaterThanEqual(this._gpuLODQuality), () => {
          state.x.assign(uint(0));
        });
      })()
        .compute(lodBuffers.count)
        .setName('rzmps.lod.cull');
      this._gpuLODCull = { buffers: lodBuffers, count: lodBuffers.count, version: lodBuffers.version, node };
    }
    if (this.system.quality < 1) sceneRenderer.compute(this._gpuLODCull.node);

    this._gpuDirtyParticleSlots.clear();
    this._updateGPURuntimeUniforms();
    const allocationBuffer = this._acquireGPUAllocationBuffer(sceneRenderer);
    allocationBuffer.reset(
      this.system.eventRuntime._gpuEventFrameSequence + 1,
      this.system.particles.reduce((count, particle) => count + (particle.alive ? 1 : 0), 0),
      this._getGPUCullingModeCode(),
    );
    const eventBuffer = this._hasGPUEventConsumers()
      ? this.execution.sharedEvents()
        ? this.execution.journal(sceneRenderer)
        : this._acquireGPUEventBuffer(sceneRenderer)
      : undefined;
    const eventWriter = eventBuffer?.createWriter(this.system.id);
    const collisionEventWriter = eventWriter
      ? this._acquireGPUCollisionEventBuffer(sceneRenderer).createWriter(this.system.eventRuntime._gpuEventFrameNode)
      : undefined;

    if (eventBuffer) {
      const eventSequence = this.system.eventRuntime._gpuEventFrameSequence + 1;
      this.system.eventRuntime._gpuEventFrameSequence = eventSequence;
      this.system.eventRuntime._gpuEventFrameNode.value = eventSequence;
      if (!eventBuffer.journal) eventBuffer.reset(eventSequence);
      eventBuffer.initialize(sceneRenderer);
    }
    this.system.eventRuntime._gpuFrameEventBuffer = eventBuffer;

    const tagMaskForEffect = (effect: SpatialEffect) => this._getGPUTagMask(effect.tags) ?? 0;
    gpuSpatialEffects.forEach(effect => effect.syncGPUTransform(this.system));
    if (!this._gpuSpatialRegistry?.update(gpuSpatialEffects, this.system, tagMaskForEffect)) {
      this._gpuSpatialRegistry?.dispose(sceneRenderer);
      this._gpuResourceBuildCount += 1;
      this._gpuSpatialRegistry = GPUSpatialEffectRegistry.build(gpuSpatialEffects, this.system, tagMaskForEffect);
    }

    const context: GPUParticleUpdateContext = {
      system: this.system,
      buffers: this._gpuBuffers,
      deltaTime: this.execution.deltaTime(),
      deltaTimeNode: this._gpuDeltaTimeNode,
      skippedTimeNode: this._gpuSkippedTimeNode,
      elapsedTimeNode: this._gpuElapsedTimeNode,
      emitterPositionNode: this._gpuEmitterPositionNode,
      gravityNode: this._gpuGravityNode,
      simulationToWorldNode: this._gpuSimulationToWorldNode,
      worldToSimulationNode: this._gpuWorldToSimulationNode,
      allocationWriter: allocationBuffer.createWriter(),
      eventWriter,
      collisionEventWriter,
    };
    const modifiers = [...modules, ...gpuSpatialEffects];

    this.system.frameRuntime._computeGPUFrameConversion(context);
    if (gpuNativeEmission || this._gpuSubSystemFrameInput) {
      this._computeGPUAllocationSnapshot(context);
    }

    if (this._gpuSubSystemFrameInput) {
      if (this._gpuSubSystemFrameInput.options.emitContinuous) {
        this._computeGPUContinuousSubSystemEmissionPhase(context, this._gpuSubSystemFrameInput);
      }
      if (
        this._gpuSubSystemFrameInput.options.emitOnDeath ||
        this._gpuSubSystemFrameInput.options.emitOnSpawn ||
        this._gpuSubSystemFrameInput.options.emitOnCollision ||
        eventNames(this._gpuSubSystemFrameInput.options.onEvent).length > 0
      ) {
        this._computeGPUEventSubSystemEmissionPhase(context, this._gpuSubSystemFrameInput);
      }
    } else {
      this._computeGPUEmissionPhase(context);
      if (this.system.emitters.some(emitter => this.execution.emitterEventNames(emitter).length)) {
        this._computeGPUEventSubSystemEmissionPhase(context, {
          parent: this.system,
          options: overrideEmitterOptions({}, {}, false),
        });
      }
    }
    this._computeStagedBirths(context);
    this.system.frameRuntime._resolveGPUSourceFrames(context);
    this._computeGPUSpawnEventPhase(context);
    eventBuffer?.produced();
    for (const module of modules) module.beginGPUExecution(this.system);

    const permanentPreMovementModifiers = modifiers
      .filter(module => module.priority < 0)
      .sort((a, b) => a.priority - b.priority);

    const transientPreMovementModifiers = modifiers
      .filter(module => module.priority >= 0 && module.priority < 1)
      .sort((a, b) => a.priority - b.priority);

    const transientRenderModifiers = modifiers
      .filter(module => module.priority >= 1)
      .sort((a, b) => a.priority - b.priority);

    this._gpuSpatialRegistry?.configureSegments([
      permanentPreMovementModifiers,
      transientPreMovementModifiers,
      transientRenderModifiers,
    ]);

    const fusedPermanentModifiers = this._computeGPUCollisionAndModifierPhases(context, permanentPreMovementModifiers);

    this._logGPUDebug('phase: fused simulation', {
      permanent: this._describeGPUModifiers(fusedPermanentModifiers),
      transientPreMovement: this._describeGPUModifiers(transientPreMovementModifiers),
    });
    this._computeGPUSimulationPhase(context, fusedPermanentModifiers, transientPreMovementModifiers,
      modules.filter(module => module.finalizeGPU !== Module.prototype.finalizeGPU));
    eventBuffer?.produced();
    this._scheduleGPUAllocationReadback(allocationBuffer, sceneRenderer);
    if (eventBuffer && !this._hasGPUNativeSubSystemConsumers()) {
      this._scheduleGPUEventReadback(eventBuffer, sceneRenderer);
    }

    const shouldRequestReadback =
      !this.execution.skipRender() && !gpuNativeEmission && !hasPendingReadback && this._shouldRequestGPUReadback();
    const readbackSequence = shouldRequestReadback ? this._gpuReadbackSequence + 1 : 0;
    const readbackParticles = shouldRequestReadback ? this.system.particles.slice(0, this._gpuBuffers.count) : [];
    const readbackWasAlive = shouldRequestReadback ? readbackParticles.map(particle => particle.alive) : [];
    const readbackStart = performance.now();
    let cpuMirrorUpdate: Promise<void> | undefined;

    if (shouldRequestReadback) {
      this._gpuReadbacksInFlight += 1;
      this._gpuReadbackPending = true;
      this._gpuCPUMirrorStale = true;
      this._gpuReadbackSequence = readbackSequence;
      this._lastGPUReadbackRequestTime = readbackStart;
      this._logGPUDebug('readback requested', {
        readbackSequence,
        readbackSource: 'main',
        readbackParticleCount: readbackParticles.length,
        readbackRate: GlobalSettings.GPU_READBACK_RATE,
        sample: this._sampleGPUParticles(readbackParticles),
      });
      cpuMirrorUpdate = this._gpuBuffers.readback(sceneRenderer, readbackParticles);
    } else {
      this._gpuCPUMirrorStale = true;
      this._logGPUDebug('readback skipped', {
        reason: hasPendingReadback ? 'pending' : 'rate limit',
        readbackRate: GlobalSettings.GPU_READBACK_RATE,
        particleCount: this.system.particles.length,
        gpuCount: this._gpuBuffers.count,
      });
    }

    if (this.execution.skipRender()) {
      this._endGPUDebugFrame(debugFrame);
      return;
    }

    const cpuInputRenderers = this.system.renderers.filter(renderer => !renderer.supportsGPUInput);
    const gpuInputRenderers = this.system.renderers.filter(renderer => renderer.supportsGPUInput);
    const renderModifiers = [...transientPreMovementModifiers, ...transientRenderModifiers];
    const needsRenderModifiers = renderModifiers.length > 0;
    const needsCompactRenderBuffer = needsRenderModifiers && gpuInputRenderers.length > 0;

    if (needsCompactRenderBuffer) {
      if (!this._gpuRenderOutputBuffers) {
        this._gpuResourceBuildCount += 1;
        this._gpuRenderOutputBuffers = createGPUParticleRenderBufferState(this._getInitialGPUBufferCapacity());
      }

      this._gpuRenderOutputBuffers.ensureCount(this._gpuBuffers.count);
      const renderOutputInitialization = this._gpuRenderOutputBuffers.initialize(sceneRenderer);

      this._logGPUDebug('phase: compact render-time output', {
        initialization: renderOutputInitialization,
        modifiers: this._describeGPUModifiers(renderModifiers),
      });

      this._computeGPURenderOutputPhase(this._gpuBuffers, this._gpuRenderOutputBuffers, renderModifiers, context);
    } else {
      this._logGPUDebug('phase: render-time transient skipped on GPU', {
        reason: needsRenderModifiers ? 'no GPU-input renderers' : 'no render-time modifiers',
        modifiers: this._describeGPUModifiers(renderModifiers),
      });
    }

    const gpuRenderBuffers = needsCompactRenderBuffer ? this._gpuRenderOutputBuffers : this._gpuBuffers;

    if (needsCompactRenderBuffer && this._gpuRenderOutputBuffers) {
      const rebuiltGrids = new Set<ParticleSpatialGrid>();
      this.system.spatialRuntime._gpuSpatialBuildSequence += 1;
      modules.forEach(module => {
        if (module.renderGPU === Module.prototype.renderGPU) return;
        const grid = module.getParticleSpatialGrid(this.system);
        if (grid && !rebuiltGrids.has(grid)) {
          grid.rebuild(sceneRenderer, context.buffers, this.system.spatialRuntime._gpuSpatialBuildSequence);
          rebuiltGrids.add(grid);
        }
        module.renderGPU(context, this._gpuRenderOutputBuffers!, sceneRenderer, grid);
      });
    }

    this._logGPUDebug('renderer handoff', {
      gpuRenderers: gpuInputRenderers.map(renderer => renderer.constructor.name),
      cpuRenderers: cpuInputRenderers.map(renderer => renderer.constructor.name),
      gpuRenderBuffer: needsCompactRenderBuffer ? 'compact render output buffer' : 'main buffer',
      cpuRenderBuffer: 'main buffer',
    });

    gpuInputRenderers.forEach(renderer => {
      renderer.updateGPU(gpuRenderBuffers!, this.system, this.execution.deltaTime());
    });

    if (!shouldRequestReadback || !cpuMirrorUpdate) {
      this._endGPUDebugFrame(debugFrame);
      return;
    }

    void (async () => {
      try {
        await cpuMirrorUpdate;
        if (lifecycleGeneration !== this._gpuLifecycleGeneration) return;

        this._gpuReadbacksInFlight = Math.max(0, this._gpuReadbacksInFlight - 1);
        this._gpuReadbackPending = this._gpuReadbacksInFlight > 0;
        this._logGPUDebug('readback resolved', {
          readbackSequence,
          durationMs: Number((performance.now() - readbackStart).toFixed(2)),
          sample: this._sampleGPUParticles(readbackParticles),
        });

        if (readbackSequence <= this._latestAppliedGPUReadbackSequence) {
          this._logGPUDebug('readback ignored: stale sequence', {
            readbackSequence,
            latestAppliedReadbackSequence: this._latestAppliedGPUReadbackSequence,
          });
          this._endGPUDebugFrame(debugFrame);
          return;
        }

        this._latestAppliedGPUReadbackSequence = readbackSequence;
        this._gpuCPUMirrorStale = this._gpuReadbackPending;
        this._applyGPUReadbackDeaths(readbackParticles, readbackWasAlive);

        const renderParticles = readbackParticles.filter(particle => particle.alive);

        if (readbackSequence < this._latestAppliedGPUReadbackSequence) {
          this._logGPUDebug('render readback ignored: stale sequence', {
            readbackSequence,
            latestAppliedReadbackSequence: this._latestAppliedGPUReadbackSequence,
          });
          this._endGPUDebugFrame(debugFrame);
          return;
        }

        if (cpuInputRenderers.length > 0) {
          this._logGPUDebug('cpu renderer readback resolved', {
            readbackSequence,
            sample: this._sampleGPUParticles(renderParticles),
          });

          cpuInputRenderers.forEach(renderer => {
            renderer.update(renderParticles, this.system, this.execution.deltaTime());
          });
        } else {
          this._logGPUDebug('cpu renderer readback skipped', {
            reason: 'no CPU-input renderers',
          });
        }

        this._endGPUDebugFrame(debugFrame);
      } catch (error) {
        if (lifecycleGeneration !== this._gpuLifecycleGeneration) return;
        this._gpuReadbacksInFlight = Math.max(0, this._gpuReadbacksInFlight - 1);
        this._gpuReadbackPending = this._gpuReadbacksInFlight > 0;
        this._logGPUDebug('readback failed', {
          readbackSequence,
          error,
          errorMessage: error instanceof Error ? error.message : String(error),
          sample: this._sampleGPUParticles(this.system.particles),
        });

        const renderParticles = this.system.particles.filter(particle => particle.alive);
        cpuInputRenderers.forEach(renderer => {
          renderer.update(renderParticles, this.system, this.execution.deltaTime());
        });

        this._endGPUDebugFrame(debugFrame);
      }
    })();
  }

  _computeGPUEmissionPhase(context: GPUParticleUpdateContext): void {
    const emitters = this.system.emitters;
    if (emitters.length <= 0) return;
    const renderer = this.system.sceneRenderer;
    if (!isWebGPURenderer(renderer)) return;

    const emitterInstances = this._acquireGPUEmitterInstances('standalone', emitters.length, emitters, renderer);
    const prepareNodes = this._getGPUEmissionPrepareComputeNodes(context, emitters, emitterInstances);
    prepareNodes.forEach(node => renderer.compute(node));
    this._getGPUEmissionComputeNodes(context, emitters, emitterInstances, false).forEach(node =>
      renderer.compute(node),
    );
    if (this.system.maxCullingMode === MaxCulling.Old) {
      this._computeGPUOldEmissionPhase(context, emitters, emitterInstances);
    }
    this._getGPUEmissionFinalizeComputeNodes(context, emitters, emitterInstances).forEach(node =>
      renderer.compute(node),
    );
  }

  _getGPUEmissionComputeNodes(
    context: GPUParticleUpdateContext,
    emitters: Emitter[],
    emitterInstances: GPUEmitterInstanceBufferState,
    reclaimOld: boolean,
  ): ComputeNode[] {
    const buffers = context.buffers;
    const cacheKey = [
      'emission',
      `reclaim:${reclaimOld}`,
      `buffer:${buffers.version}:${buffers.capacity}`,
      `initializers:${this._getParticleInitializationSignature()}`,
      `emitters:${emitters.map(emitter => `${this._getObjectSignature(emitter)}@${emitter.version}`).join(',')}`,
    ].join('|');

    const cached = this._gpuEmissionComputeCache;
    if (cached?.key === cacheKey) {
      return cached.nodes;
    }

    cached?.nodes.forEach(node => node.dispose?.());

    // Keep each emitter in its own pass so geometry sampling bindings do not
    // accumulate with emitter count and exceed WebGPU's default stage limit.
    const nodes = emitters.map((emitter, emitterIndex) =>
      Fn(() => {
        if (emitter.sources !== undefined || !this.system.getEmitterOptions(emitter).emitContinuous) return;
        emitter.createBuiltInGPUUpdate()({
          ...context,
          emitter,
          emitterIndex,
          output: buffers,
          emitterRuntime: emitterInstances.createRuntime(emitterIndex),
          emissionFrame:
            this.system.simulationSpace === SimulationSpace.World ||
            this.system.simulationSpace === SimulationSpace.Transform
              ? this._gpuEmissionFrameNode
              : undefined,
          tagMasks: this._getGPUEmitterTagMasks(emitter),
          reclaimOld,
        });
      })().compute(buffers.capacity),
    );

    const entry = {
      key: cacheKey,
      nodes,
    };
    this._gpuPipelineBuildCount += nodes.length;
    this._gpuEmissionComputeCache = entry;

    return nodes;
  }

  _computeGPUOldEmissionPhase(
    context: GPUParticleUpdateContext,
    emitters: Emitter[],
    emitterInstances: GPUEmitterInstanceBufferState,
  ): void {
    const renderer = this.system.sceneRenderer;
    if (!isWebGPURenderer(renderer) || !context.allocationWriter) return;

    const selectionKey = [
      'old-emission-selection',
      `buffer:${context.buffers.version}:${context.buffers.capacity}`,
      `instances:${emitterInstances.capacity}`,
      `initializers:${this._getParticleInitializationSignature()}`,
      `emitters:${emitters.map(emitter => `${this._getObjectSignature(emitter)}@${emitter.version}`).join(',')}`,
    ].join('|');
    if (this._gpuOldSelectionComputeCache?.key !== selectionKey) {
      this._gpuPipelineBuildCount += 1;
      this._gpuOldSelectionComputeCache?.nodes.forEach(node => node.dispose?.());
      this._gpuOldSelectionComputeCache = {
        key: selectionKey,
        nodes: emitters.map((_emitter, emitterIndex) =>
          Fn(() => {
            const particle = context.buffers.storage.createParticle(undefined, true);
            const runtime = emitterInstances.createRuntime(emitterIndex);
            const requested = runtime.requestCount();
            const deadClaims = runtime.claimCount();
            const deadSuccesses = deadClaims.lessThan(requested).select(deadClaims, requested) as Node<'uint'>;
            context.allocationWriter!.selectOldSlotForEmitter(particle, requested.sub(deadSuccesses), () =>
              runtime.claimReplacement(),
            );
          })().compute(context.buffers.capacity),
        ),
      };
    }

    const initializationKey = [
      'old-emission-initialization',
      `buffer:${context.buffers.version}:${context.buffers.capacity}`,
      `instances:${emitterInstances.capacity}`,
      `initializers:${this._getParticleInitializationSignature()}`,
      `emitters:${emitters.map(emitter => `${this._getObjectSignature(emitter)}@${emitter.version}`).join(',')}`,
    ].join('|');
    if (this._gpuOldEmissionComputeCache?.key !== initializationKey) {
      this._gpuPipelineBuildCount += 1;
      this._gpuOldEmissionComputeCache?.nodes.forEach(node => node.dispose?.());
      this._gpuOldEmissionComputeCache = {
        key: initializationKey,
        nodes: emitters.map((emitter, emitterIndex) => {
          return Fn(() => {
            emitter.createBuiltInGPUUpdate()({
              ...context,
              eventWriter: undefined,
              emitter,
              emitterIndex,
              output: context.buffers,
              emitterRuntime: emitterInstances.createRuntime(emitterIndex),
              tagMasks: this._getGPUEmitterTagMasks(emitter),
              reclaimOld: true,
            });
          })().compute(context.buffers.capacity);
        }),
      };
    }

    emitters.forEach((_emitter, emitterIndex) => {
      renderer.compute(this._gpuOldSelectionComputeCache!.nodes[emitterIndex]);
      this._computeGPUOldDeathEventPhase(context);
      renderer.compute(this._gpuOldEmissionComputeCache!.nodes[emitterIndex]);
    });
  }

  _computeGPUOldDeathEventPhase(context: GPUParticleUpdateContext): void {
    const renderer = this.system.sceneRenderer;
    if (!isWebGPURenderer(renderer) || !context.allocationWriter || !context.eventWriter) return;
    const cacheKey = [
      'old-emission-deaths',
      `buffer:${context.buffers.version}:${context.buffers.capacity}`,
      `events:${context.eventWriter.version}:${context.eventWriter.capacity}`,
    ].join('|');

    if (this._gpuOldDeathEventComputeCache?.key !== cacheKey) {
      this._gpuPipelineBuildCount += 1;
      this._gpuOldDeathEventComputeCache?.node.dispose?.();
      this._gpuOldDeathEventComputeCache = {
        key: cacheKey,
        node: Fn(() => {
          const particle = context.buffers.storage.createParticle(undefined, true);
          If(context.allocationWriter!.isSelectedForReplacement(particle), () => {
            context.eventWriter!.emitDeath(particle);
          });
        })().compute(context.buffers.capacity),
      };
    }

    renderer.compute(this._gpuOldDeathEventComputeCache.node);
  }

  _computeGPUAllocationSnapshot(context: GPUParticleUpdateContext): void {
    const renderer = this.system.sceneRenderer;
    if (!isWebGPURenderer(renderer) || !context.allocationWriter) return;
    const cacheKey = `allocation-snapshot:${context.buffers.version}:${context.buffers.capacity}`;

    if (this._gpuAllocationSnapshotComputeCache?.key !== cacheKey) {
      this._gpuPipelineBuildCount += 1;
      this._gpuAllocationSnapshotComputeCache?.node.dispose?.();
      const node = Fn(() => {
        context.allocationWriter!.snapshotAlive(context.buffers.storage.createParticle(undefined, true));
      })().compute(context.buffers.capacity);
      this._gpuAllocationSnapshotComputeCache = { key: cacheKey, node };
    }

    renderer.compute(this._gpuAllocationSnapshotComputeCache.node);
  }

  _computeGPUSpawnEventPhase(context: GPUParticleUpdateContext): void {
    const renderer = this.system.sceneRenderer;
    if (!isWebGPURenderer(renderer) || !context.allocationWriter || !context.eventWriter) return;
    const cacheKey = [
      'spawn-events',
      `buffer:${context.buffers.version}:${context.buffers.capacity}`,
      `events:${context.eventWriter.version}:${context.eventWriter.capacity}`,
    ].join('|');

    if (this._gpuSpawnEventComputeCache?.key !== cacheKey) {
      this._gpuPipelineBuildCount += 1;
      this._gpuSpawnEventComputeCache?.node.dispose?.();
      const node = Fn(() => {
        const particle = context.buffers.storage.createParticle(undefined, true);
        If(context.allocationWriter!.wasSpawned(particle).and(particle.alive.notEqual(uint(0))), () => {
          context.eventWriter!.emitSpawn(particle);
        });
      })().compute(context.buffers.capacity);
      this._gpuSpawnEventComputeCache = { key: cacheKey, node };
    }

    renderer.compute(this._gpuSpawnEventComputeCache.node);
  }

  _getGPUEmissionFinalizeComputeNodes(
    context: GPUParticleUpdateContext,
    emitters: Emitter[],
    emitterInstances: GPUEmitterInstanceBufferState,
  ): ComputeNode[] {
    const cacheKey = [
      'emission-finalize',
      `instances:${emitterInstances.capacity}`,
      `culling:${this.system.maxCullingMode}`,
      `defer:${context.buffers.capacity < this.system.maxParticles}`,
      `initializers:${this._getParticleInitializationSignature()}`,
      `emitters:${emitters.map(emitter => `${this._getObjectSignature(emitter)}@${emitter.version}`).join(',')}`,
    ].join('|');
    if (this._gpuEmissionFinalizeComputeCache?.key === cacheKey) {
      return this._gpuEmissionFinalizeComputeCache.nodes;
    }

    this._gpuEmissionFinalizeComputeCache?.nodes.forEach(node => node.dispose?.());
    const nodes = emitters.map((_emitter, emitterIndex) =>
      Fn(() => {
        const runtime = emitterInstances.createRuntime(emitterIndex);
        const requested = runtime.requestCount();
        const deadClaims = runtime.claimCount();
        const deadSuccesses = deadClaims.lessThan(requested).select(deadClaims, requested) as Node<'uint'>;
        const afterDead = requested.sub(deadSuccesses);
        const replacementClaims = runtime.replacementCount();
        const replacementSuccesses =
          this.system.maxCullingMode === MaxCulling.Old
            ? (replacementClaims.lessThan(afterDead).select(replacementClaims, afterDead) as Node<'uint'>)
            : uint(0);
        const failures = afterDead.sub(replacementSuccesses);
        context.allocationWriter?.recordAllocationFailures(failures);
        runtime.setPendingRequestCount(context.buffers.capacity < this.system.maxParticles ? failures : uint(0));
      })().compute(1),
    );

    this._gpuEmissionFinalizeComputeCache = { key: cacheKey, nodes };
    this._gpuPipelineBuildCount += nodes.length;
    return nodes;
  }

  _getGPUEmissionPrepareComputeNodes(
    context: GPUParticleUpdateContext,
    emitters: Emitter[],
    emitterInstances: GPUEmitterInstanceBufferState,
  ): ComputeNode[] {
    const cacheKey = [
      'emission-prepare',
      `instances:${emitterInstances.capacity}`,
      `initializers:${this._getParticleInitializationSignature()}`,
      `emitters:${emitters.map(emitter => `${this._getObjectSignature(emitter)}@${emitter.version}`).join(',')}`,
    ].join('|');

    if (this._gpuEmissionPrepareComputeCache?.key === cacheKey) {
      return this._gpuEmissionPrepareComputeCache.nodes;
    }

    this._gpuEmissionPrepareComputeCache?.nodes.forEach(node => node.dispose?.());
    this._gpuEmissionFinalizeComputeCache?.nodes.forEach(node => node.dispose?.());
    const nodes = emitters.map((emitter, emitterIndex) =>
      Fn(() => {
        if (emitter.sources !== undefined || !this.system.getEmitterOptions(emitter).emitContinuous) {
          emitterInstances.createRuntime(emitterIndex).resetRequestCount(uint(0));
          return;
        }
        emitter.prepareBuiltInGPUEmission({
          ...context,
          emitter,
          emitterIndex,
          output: context.buffers,
          emitterRuntime: emitterInstances.createRuntime(emitterIndex),
          durationNode: this._gpuDurationNode,
          skippedClockWrapNode: this._gpuSkippedClockWrapNode,
          tagMasks: this._getGPUEmitterTagMasks(emitter),
        });
      })().compute(1),
    );

    this._gpuEmissionPrepareComputeCache = { key: cacheKey, nodes };
    this._gpuPipelineBuildCount += nodes.length;
    return nodes;
  }

  _computeStagedBirths(context: GPUParticleUpdateContext): void {
    const renderer = this.system.sceneRenderer;
    if (!this.system.emissionRuntime._stagedBirths.length || !isWebGPURenderer(renderer)) return;
    const count = Math.min(this.system.emissionRuntime._stagedBirths.length, context.buffers.capacity);
    const capacity = nextPowerOfTwo(count);
    if (!this._stagedBirthBuffers || this._stagedBirthBuffers.capacity < capacity) {
      this._stagedBirthBuffers?.dispose(renderer);
      this._stagedBirthBuffers = createEmptyGPUParticleBufferState(capacity);
    }
    const births = this._stagedBirthBuffers;
    births.upload(this.system.emissionRuntime._stagedBirths.slice(0, count), p => this._getParticleGPUTagMask(p));
    births.initialize(renderer);
    this._stagedBirthCount.value = count;
    const key =
      `${births.capacity}` +
      ':' +
      `${context.buffers.version}` +
      ':' +
      `${context.buffers.capacity}` +
      ':' +
      `${context.eventWriter?.version}`;
    if (this._stagedBirthCompute?.key !== key) {
      this._stagedBirthCompute?.nodes.forEach(node => node.dispose());
      const node = Fn(() => {
        const particle = context.buffers.storage.createParticle(undefined, true);
        context.allocationWriter!.claimDeadSlotForEmitter(
          particle,
          this._stagedBirthCount,
          () => context.allocationWriter!.claimEmissionRun(),
          claim => {
            const birth = births.storage.createParticle(claim);
            context.buffers.storage.storeParticle(
              Object.assign(birth, {
                index: particle.index,
                generation: particle.generation,
                alive: uint(1),
              }),
            );
            context.buffers.storage
              .createSourceIdentityNode(particle.index)
              .assign(births.storage.createSourceIdentityNode(claim));
            context.allocationWriter!.markSpawned(particle);
          },
        );
      })().compute(context.buffers.capacity);
      const reset = Fn(() => {
        context.allocationWriter!.resetEmissionRunClaims();
      })().compute(1);
      this._stagedBirthCompute = { key, nodes: [reset, node] };
    }
    this._stagedBirthCompute.nodes.forEach(node => renderer.compute(node));
    this.system.emissionRuntime._stagedBirths.length = 0;
  }

  _computeGPUContinuousSubSystemEmissionPhase(context: GPUParticleUpdateContext, input: GPUSubSystemFrameInput): void {
    const parentBuffers = input.parent.gpuSimulation._gpuBuffers;
    const renderer = this.system.sceneRenderer;
    if (!parentBuffers || !isWebGPURenderer(renderer)) return;

    const emitters = this.system.emitters;
    if (emitters.length === 0) return;

    const predicates = emitters.map(emitter => this.subSystemPredicates.evaluate(input.parent, this.system,
      this.system.getEmitterOptions(emitter), renderer));

    const contextCount = parentBuffers.capacity * emitters.length;
    const emitterInstances = this._acquireGPUEmitterInstances(
      'continuous',
      contextCount + emitters.length,
      emitters,
      renderer,
    );
    const cacheKey = [
      'continuous-subsystem',
      `parent:${this._getObjectSignature(parentBuffers)}:${parentBuffers.version}:${parentBuffers.capacity}`,
      `predicates:${predicates.map(state => state ? this._getObjectSignature(state) : 'none')}`,
      `child:${context.buffers.version}:${context.buffers.capacity}`,
      `instances:${emitterInstances.capacity}`,
      'options:' +
        `${emitters.map(emitter => this._getSubSystemGPUOptionsSignature(this.system.getEmitterOptions(emitter)))}`,
      `initializers:${this._getParticleInitializationSignature()}`,
      `emitters:${emitters.map(emitter => `${this._getObjectSignature(emitter)}@${emitter.version}`).join(',')}`,
    ].join('|');

    if (this._gpuContinuousSubSystemComputeCache?.key !== cacheKey) {
      this._gpuPipelineBuildCount += 1;
      this._gpuContinuousSubSystemComputeCache?.nodes.forEach(node => node.dispose?.());
      const nodes: ComputeNode[] = [];

      emitters.forEach((emitter, emitterIndex) => {
        const options = this.system.getEmitterOptions(emitter);
        if (!options.emitContinuous || emitter.sources !== undefined) return;
        const globalRuntime = emitterInstances.createRuntime(contextCount + emitterIndex);
        nodes.push(
          Fn(() => {
            globalRuntime.resetRequestCount(uint(0));
          })().compute(1),
        );

        nodes.push(
          Fn(() => {
            const parent = parentBuffers.storage.createParticle(undefined, true);
            const runtimeIndex = instanceIndex.mul(emitters.length).add(emitterIndex);
            const runtime = emitterInstances.createRuntime(runtimeIndex);
            const ratioEligible =
              options.ratio >= 1
                ? uint(1).equal(uint(1))
                : hash(instanceIndex.add(parent.generation.mul(65537))).lessThanEqual(float(options.ratio));
            const predicateEligible = predicates[emitterIndex]
              ? predicates[emitterIndex]!.storage.element(instanceIndex).notEqual(0) : options.shouldEmit === true;
            const eligible = parent.alive
              .notEqual(uint(0))
              .and(ratioEligible)
              .and(predicateEligible)
              .and(
                options.tags
                  ? parent.tagMask.bitAnd(uint(this._getGPUTagMask(options.tags) ?? 0)).notEqual(uint(0))
                  : true,
              );

            If(eligible, () => {
              const identityChanged = runtime.identity.x
                .equal(uint(0))
                .or(runtime.identity.y.notEqual(parent.index))
                .or(runtime.identity.z.notEqual(parent.generation));
              If(identityChanged, () => {
                runtime.identity.x.assign(uint(0));
                runtime.identity.y.assign(parent.index);
                runtime.identity.z.assign(parent.generation);
                runtime.identity.w.assign(uint(emitterIndex));
              });

              const sourceSkipped = runtime.identity.x
                .notEqual(uint(0))
                .select(context.skippedTimeNode ?? float(0), float(0))
                .toVar('sourceSkippedTime');
              emitter.prepareBuiltInGPUEmission({
                ...context,
                skippedTimeNode: sourceSkipped,
                loopingClock: options.inheritLifetime <= 0 && this.system.looping,
                elapsedTimeNode: runtime.timing.w.add(context.deltaTimeNode).add(sourceSkipped),
                durationNode: mix(this._gpuDurationNode, parent.lifetime, float(options.inheritLifetime)),
                normalizedTimeNode: options.inheritLifetime > 0 ? parent.time.mul(options.inheritLifetime) : undefined,
                emitterPositionNode: parent.position,
                emitter,
                emitterIndex,
                output: context.buffers,
                emitterRuntime: runtime,
              });
              runtime.queueBirths(context.allocationWriter!, globalRuntime, parent.index);
            }).Else(() => {
              runtime.retire();
            });
          })().compute(parentBuffers.capacity),
        );

        const emitGPU = emitter.createBuiltInGPUUpdate()!;
        nodes.push(
          Fn(() => {
            const resolveParentSlot = (claimIndex: Node<'uint'>): Node<'uint'> =>
              context.allocationWriter!.emissionSource(claimIndex);

            emitGPU({
              ...context,
              emitter,
              emitterIndex,
              output: context.buffers,
              emitterRuntime: globalRuntime,
              tagMasks: this._getGPUEmitterTagMasks(emitter),
              inheritance: {
                color: options.inheritColor,
                alpha: options.inheritAlpha,
                mass: options.inheritMass,
                velocity: options.inheritVelocity,
                scale: options.inheritScale,
              },
              resolveParentParticle: claimIndex =>
                parentBuffers.storage.createParticle(resolveParentSlot(claimIndex), true),
              resolveInheritedVelocity: claim => {
                const source = parentBuffers.storage.createParticle(resolveParentSlot(claim));
                const velocity = this._gpuParentToSimulationNode.mul(vec4(source.velocity, 0));
                return (
                  this.system.simulationSpace === SimulationSpace.Source
                    ? inverse(this._gpuParentToSimulationNode.mul(particleFrameGPU(source, options.inheritScale))).mul(
                        velocity,
                      )
                    : velocity
                ).xyz.mul(options.inheritVelocity);
              },
              resolveInitializationContext: claim => {
                const source = parentBuffers.storage.createParticle(resolveParentSlot(claim));
                const sourceToWorld = input.parent.gpuSimulation._gpuSimulationToWorldNode;
                return {
                  source,
                  sourceToWorld,
                  birthToWorld:
                    this.system.simulationSpace === SimulationSpace.Source
                      ? sourceToWorld.mul(particleFrameGPU(source, options.inheritScale))
                      : context.simulationToWorldNode,
                };
              },
              sourceRelative: this.system.simulationSpace === SimulationSpace.Source,
              resolveSourceIdentity:
                this.system.simulationSpace === SimulationSpace.Source
                  ? claim => {
                      const source = parentBuffers.storage.createParticle(resolveParentSlot(claim));
                      return bitcast(uvec4(source.index, source.generation, 1, 0), 'vec4') as unknown as Node<'vec4'>;
                    }
                  : undefined,
              resolveEmissionTransform: claim => {
                if (this.system.simulationSpace === SimulationSpace.Source) return mat4(new THREE.Matrix4());
                const source = parentBuffers.storage.createParticle(resolveParentSlot(claim));
                return this._gpuParentToSimulationNode.mul(particleFrameGPU(source, options.inheritScale));
              },
              resolveBirthOffset: claim => {
                const runtime = emitterInstances.createRuntime(
                  resolveParentSlot(claim).mul(emitters.length).add(emitterIndex),
                );
                return runtime.birthOffset(claim.sub(uint(runtime.birthSchedule(0).w)), emitter.bursts.length);
              },
              resolveEmissionTime: claimIndex => {
                const parentSlot = resolveParentSlot(claimIndex);
                if (options.inheritLifetime > 0) {
                  return parentBuffers.storage.createParticle(parentSlot, true).time.mul(options.inheritLifetime);
                }
                const runtimeIndex = parentSlot.mul(emitters.length).add(emitterIndex);
                return emitterInstances.createRuntime(runtimeIndex).timing.w.div(this._gpuDurationNode);
              },
            });
          })().compute(context.buffers.capacity),
        );
      });

      this._gpuContinuousSubSystemComputeCache = { key: cacheKey, nodes };
    }

    this._gpuContinuousSubSystemComputeCache.nodes.forEach(node => renderer.compute(node));
  }

  _computeGPUEventSubSystemEmissionPhase(context: GPUParticleUpdateContext, input: GPUSubSystemFrameInput): void {
    const eventBuffer =
      this.execution.eventRoot().eventRuntime._sharedGPUEvents ?? input.parent.eventRuntime._gpuFrameEventBuffer;
    const renderer = this.system.sceneRenderer;
    if (!eventBuffer || !isWebGPURenderer(renderer)) return;

    const emitters = this.system.emitters;
    if (emitters.length === 0) return;

    const runCapacity = Math.min(eventBuffer.capacity, Math.max(this.system.maxParticles, 1));
    const runs = this._acquireGPUEmissionRuns(runCapacity * emitters.length, renderer);
    const contextCount = runs.capacity;
    const configurations = emitters.map(emitter => this.system.getEmitterOptions(emitter));
    const origins = emitters.map(emitter => emitter.visibleSystems(this.system));
    const readers = emitters.map(emitter => {
      const batch = eventBuffer.journal ? emitter.beginGPUExecution(this.system).events : undefined;
      return batch instanceof SharedGPUEventBatch ? batch.reader : eventBuffer.createReader();
    });
    const predicates = emitters.map((_emitter, i) => this.subSystemPredicates.evaluate(input.parent, this.system,
      configurations[i], renderer, readers[i], eventBuffer.capacity, origins[i], eventBuffer.journal));
    const emitterInstances = this._acquireGPUEmitterInstances(
      'event',
      contextCount + emitters.length,
      emitters,
      renderer,
    );
    const cacheKey = [
      'event-subsystem',
      `events:${this._getObjectSignature(eventBuffer)}:${eventBuffer.version}:${eventBuffer.capacity}`,
      `predicates:${predicates.map(state => state ? this._getObjectSignature(state) : 'none')}`,
      `runs:${runs.capacity}`,
      `child:${context.buffers.version}:${context.buffers.capacity}`,
      `instances:${emitterInstances.capacity}`,
      `options:${configurations.map(options => this._getSubSystemGPUOptionsSignature(options)).join('|')}`,
      'producers:' +
        `${origins.map(values => values.map(owner => `${owner.id}:${[...owner.eventRuntime._eventTypes]}`)).join('|')}`,
      `ranges:${readers.map(reader => reader.versionKey).join('|')}`,
      `initializers:${this._getParticleInitializationSignature()}`,
      `emitters:${emitters.map(emitter => `${this._getObjectSignature(emitter)}@${emitter.version}`).join(',')}`,
    ].join('|');

    if (this._gpuEventSubSystemComputeCache?.key !== cacheKey) {
      this._gpuPipelineBuildCount += 1;
      this._gpuEventSubSystemComputeCache?.nodes.forEach(node => node.dispose?.());
      const nodes: ComputeNode[] = [];
      nodes.push(
        Fn(() => {
          const run = runs.load(instanceIndex);
          If(run.active.notEqual(uint(0)), () => {
            run.elapsed.addAssign(context.skippedTimeNode ?? float(0));
          });
        })().compute(runs.capacity),
      );

      emitters.forEach((_emitter, emitterIndex) => {
        const options = configurations[emitterIndex];
        const reader = readers[emitterIndex];
        nodes.push(Fn(() => context.allocationWriter?.resetEmissionRunClaims())().compute(1));
        nodes.push(
          Fn(() => {
            const runIndex = instanceIndex.add(emitterIndex * runCapacity);
            const run = runs.load(runIndex);
            const eventCount = reader.count().toVar('subsystemEventCount');
            If(run.active.equal(uint(0)), () => {
              Loop({ start: 0, end: eventCount, type: 'uint' }, () => {
                const eventIndex = context.allocationWriter!.claimEmissionRun().toVar('eventRunClaim');
                If(eventIndex.lessThan(eventCount), () => {
                  const event = reader.load(eventIndex);
                  let typeEligible = uint(0).equal(uint(1));
                  for (const producer of origins[emitterIndex]) {
                    if (!eventBuffer.journal && producer !== input.parent) continue;
                    for (const [name, type] of producer.eventRuntime._eventTypes) {
                      if (!subscribes(options, name) || !this._canHandleNativeGPUEvent(producer, options, name)) {
                        continue;
                      }
                      const matches = event.type.equal(uint(type));
                      typeEligible = typeEligible.or(
                        eventBuffer.journal ? matches.and(event.origin.equal(uint(producer.id))) : matches,
                      );
                    }
                  }
                  if (options.tags)
                    typeEligible = typeEligible.and(
                      event.particle.tagMask.bitAnd(uint(this._getGPUTagMask(options.tags) ?? 0)).notEqual(uint(0)),
                    );
                  const ratioEligible =
                    options.ratio >= 1
                      ? uint(1).equal(uint(1))
                      : hash(event.slot.add(event.generation.mul(65537))).lessThanEqual(float(options.ratio));
                  const predicateEligible = predicates[emitterIndex]
                    ? predicates[emitterIndex]!.storage.element(eventIndex).notEqual(0) : options.shouldEmit === true;
                  const impulseEligible = event.type
                    .notEqual(uint(GPUEventType.Collision))
                    .or(event.collisionImpulse.length().greaterThan(float(options.impulseThreshold)));

                  If(typeEligible.and(ratioEligible).and(predicateEligible).and(impulseEligible), () => {
                    const producerFrame = mat4(new THREE.Matrix4()).toVar('eventProducerFrame');
                    for (const producer of origins[emitterIndex]) {
                      const frame = this._gpuWorldToSimulationNode.mul(
                        producer.gpuSimulation._gpuSimulationToWorldNode,
                      );
                      if (eventBuffer.journal) {
                        If(event.origin.equal(uint(producer.id)), () => {
                          producerFrame.assign(frame);
                        });
                      } else if (producer === input.parent) producerFrame.assign(frame);
                    }
                    const impulseDuration =
                      options.impulseAffectsLifetime > 0
                        ? (event.type
                            .equal(uint(GPUEventType.Collision))
                            .select(
                              pow(event.collisionImpulse.length().max(float(0)), float(options.impulseAffectsLifetime)),
                              float(0),
                            ) as Node<'float'>)
                        : float(0);
                    const duration = mix(
                      this._gpuDurationNode,
                      event.particle.lifetime,
                      float(options.inheritLifetime),
                    ).add(impulseDuration);

                    const transformScale = mix(vec3(1), event.particle.scale, float(Math.max(0, options.inheritScale)));
                    const rotate = (v: Node<'vec3'>): Node<'vec3'> => {
                      const base = mat3(particleFrameGPU(event.particle, 0)).mul(v);
                      return options.impulseAffectsAlignment
                        ? (event.collisionImpulse
                            .length()
                            .greaterThan(0)
                            .select(rotateFromYGPU(v, event.collisionImpulse), base) as Node<'vec3'>)
                        : base;
                    };
                    const transform = mat4(
                      vec4(rotate(vec3(transformScale.x, 0, 0)), 0),
                      vec4(rotate(vec3(0, transformScale.y, 0)), 0),
                      vec4(rotate(vec3(0, 0, transformScale.z)), 0),
                      vec4(event.particle.position, 1),
                    );
                    const impulseMass = event.type
                      .equal(uint(GPUEventType.Collision))
                      .select(
                        pow(event.collisionImpulse.length().max(0), Math.max(0, options.impulseAffectsMass)),
                        float(1),
                      );
                    const resolved: GPUEmissionContext = {
                      transform: producerFrame.mul(transform),
                      position: producerFrame.mul(vec4(event.particle.position, 1)).xyz,
                      color: mix(vec3(1), event.particle.color, float(Math.max(0, options.inheritColor))),
                      alpha: mix(float(1), event.particle.alpha, float(Math.max(0, options.inheritAlpha))),
                      mass: mix(float(1), event.particle.mass, float(Math.max(0, options.inheritMass))).mul(
                        impulseMass,
                      ),
                      velocity: producerFrame
                        .mul(vec4(event.particle.velocity, 0))
                        .xyz.mul(Math.max(0, options.inheritVelocity)),
                      scale: event.type
                        .equal(uint(GPUEventType.Collision))
                        .select(
                          pow(event.collisionImpulse.length().max(0), options.impulseAffectsScale),
                          float(1),
                        ) as Node<'float'>,
                      velocityScale: event.type
                        .equal(uint(GPUEventType.Collision))
                        .select(
                          pow(event.collisionImpulse.length().max(0), options.impulseAffectsSpeed),
                          float(1),
                        ) as Node<'float'>,
                      distortionStrength: float(1),
                      duration,
                    };
                    const contextValues = Object.fromEntries(
                      Object.entries(resolved).map(([key, node]) => [key, node.toVar(`eventContext_${key}`)]),
                    ) as unknown as GPUEmissionContext;
                    const subscriptions = options.onEvent;
                    if (subscriptions && !Array.isArray(subscriptions)) {
                      for (const [name, handler] of Object.entries(subscriptions.gpu ?? {})) {
                        let matches = uint(0).equal(uint(1));
                        for (const producer of origins[emitterIndex]) {
                          const type = producer.eventRuntime._eventTypes.get(name);
                          if (type === undefined || (!eventBuffer.journal && producer !== input.parent)) continue;
                          const named = event.type.equal(uint(type));
                          matches = matches.or(
                            eventBuffer.journal ? named.and(event.origin.equal(uint(producer.id))) : named,
                          );
                        }
                        If(matches, () => {
                          const overrides = handler(event.data, event.particle, contextValues);
                          if (overrides === false) {
                            Continue();
                          } else if (overrides && 'isNode' in overrides) {
                            If((overrides as Node<'bool'>).not(), () => {
                              Continue();
                            });
                          } else if (overrides) {
                            for (const [key, value] of Object.entries(overrides)) {
                              (contextValues[key as keyof GPUEmissionContext] as Node).assign(value);
                            }
                            if (overrides.position && !overrides.transform)
                              matrixColumnGPU(contextValues.transform, 3).assign(vec4(overrides.position, 1));
                            if (overrides.transform && !overrides.position) {
                              contextValues.position.assign(matrixColumnGPU(overrides.transform, 3).xyz);
                            }
                          }
                        });
                      }
                    }
                    if (this.system.simulationSpace === SimulationSpace.Source) {
                      // Death-triggered births retain the final snapshot
                      // instead of attaching to an already-dead source.
                      If(event.type.notEqual(uint(GPUEventType.Death)), () => {
                        const sourceFrame = producerFrame.mul(particleFrameGPU(event.particle, options.inheritScale));
                        const toSource = inverse(sourceFrame);
                        contextValues.transform.assign(toSource.mul(contextValues.transform));
                        contextValues.position.assign(toSource.mul(vec4(contextValues.position, 1)).xyz);
                        contextValues.velocity.assign(toSource.mul(vec4(contextValues.velocity, 0)).xyz);
                        runs.snapshots.storage
                          .createSourceIdentityNode(runIndex)
                          .assign(
                            bitcast(
                              uvec4(
                                event.slot,
                                event.generation,
                                eventBuffer.journal
                                  ? event.origin
                                      .equal(uint(this.system.subSystemParent?.id ?? -1))
                                      .select(uint(1), event.origin.add(uint(3)))
                                  : uint(1),
                                0,
                              ),
                              'vec4',
                            ),
                          );
                      }).Else(() => {
                        runs.snapshots.storage.createSourceIdentityNode(runIndex).assign(vec4(0));
                      });
                    }
                    runs.storeEvent(runIndex, event, producerFrame);
                    runs.storeParticle(runIndex, {
                      ...event.particle,
                      alive: uint(1),
                      realtime: float(0),
                      lifetime: contextValues.duration,
                      position: contextValues.position,
                      rotation: event.collisionNormal,
                      scale: transformScale,
                      color: contextValues.color,
                      alpha: contextValues.alpha,
                      mass: contextValues.mass,
                      velocity: contextValues.velocity,
                      speed: contextValues.scale,
                      distortionStrength: contextValues.velocityScale,
                      // Event-specific values are resolved now; the payload need not survive in run storage.
                      acceleration: matrixColumnGPU(contextValues.transform, 0).xyz,
                      angularAcceleration: matrixColumnGPU(contextValues.transform, 1).xyz,
                      scalarAcceleration: matrixColumnGPU(contextValues.transform, 2).xyz,
                      angularVelocity: matrixColumnGPU(contextValues.transform, 3).xyz,
                      scalarVelocity: event.collisionImpulse,
                      orbitCenter: event.collisionPoint,
                      lodPriority: event.type,
                      time: contextValues.distortionStrength,
                    });
                    Break();
                  });
                }).Else(() => {
                  Break();
                });
              });
            });
          })().compute(runCapacity),
        );
      });

      nodes.push(
        Fn(() => {
          const run = runs.load(instanceIndex);
          If(run.active.notEqual(uint(0)), () => {
            run.elapsed.addAssign(context.deltaTimeNode);
          });
        })().compute(runs.capacity),
      );

      emitters.forEach((emitter, emitterIndex) => {
        const options = this.system.getEmitterOptions(emitter);
        const globalRuntime = emitterInstances.createRuntime(contextCount + emitterIndex);
        nodes.push(Fn(() => globalRuntime.resetRequestCount(uint(0)))().compute(1));
        nodes.push(
          Fn(() => {
            const runIndex = instanceIndex.add(emitterIndex * runCapacity);
            const run = runs.load(runIndex);
            const runtime = emitterInstances.createRuntime(runIndex);

            If(run.active.notEqual(uint(0)).and(run.elapsed.lessThan(run.duration)), () => {
              emitter.prepareBuiltInGPUEmission({
                ...context,
                elapsedTimeNode: run.elapsed,
                skippedTimeNode: runtime.identity.x
                  .notEqual(uint(0))
                  .select(context.skippedTimeNode ?? float(0), float(0)),
                durationNode: run.duration,
                emitterPositionNode: run.particle.position,
                countScaleNode:
                  (options.impulseAffectsCount ?? 0) > 0
                    ? run.eventType
                        .equal(uint(GPUEventType.Collision))
                        .select(pow(run.collisionImpulse.length().max(0), options.impulseAffectsCount ?? 0), float(1))
                    : undefined,
                emitter,
                emitterIndex,
                output: context.buffers,
                emitterRuntime: runtime,
              });
              runtime.queueBirths(context.allocationWriter!, globalRuntime, runIndex);
            }).Else(() => {
              runtime.retire();
            });
          })().compute(runCapacity),
        );

        const emitGPU = emitter.createBuiltInGPUUpdate()!;
        nodes.push(
          Fn(() => {
            const resolveRunIndex = (claimIndex: Node<'uint'>): Node<'uint'> =>
              context.allocationWriter!.emissionSource(claimIndex);

            emitGPU({
              ...context,
              emitter,
              emitterIndex,
              output: context.buffers,
              emitterRuntime: globalRuntime,
              tagMasks: this._getGPUEmitterTagMasks(emitter),
              inheritance: { color: 1, alpha: 1, mass: 1, velocity: 1, scale: 1 },
              resolveSourceIdentity:
                this.system.simulationSpace === SimulationSpace.Source
                  ? claim => runs.snapshots.storage.createSourceIdentityNode(resolveRunIndex(claim))
                  : undefined,
              resolveInitializationContext: claim => {
                const index = resolveRunIndex(claim);
                const event = runs.event(index);
                const sourceToWorld = runs.sourceToWorld(index);
                const birthToWorld =
                  this.system.simulationSpace === SimulationSpace.Source
                    ? (event.type
                        .notEqual(uint(GPUEventType.Death))
                        .select(
                          sourceToWorld.mul(particleFrameGPU(event.particle, options.inheritScale)),
                          context.simulationToWorldNode,
                        ) as Node<'mat4'>)
                    : context.simulationToWorldNode;
                return { event, source: event.particle, sourceToWorld, birthToWorld };
              },
              resolveParentParticle: claimIndex => runs.load(resolveRunIndex(claimIndex)).particle,
              resolveDistortionStrength: claimIndex => runs.load(resolveRunIndex(claimIndex)).particle.time,
              resolveEmissionTransform: claimIndex => {
                const p = runs.load(resolveRunIndex(claimIndex)).particle;
                return mat4(
                  vec4(p.acceleration, 0),
                  vec4(p.angularAcceleration, 0),
                  vec4(p.scalarAcceleration, 0),
                  vec4(p.angularVelocity, 1),
                );
              },
              resolveBirthOffset: claim => {
                const runtime = emitterInstances.createRuntime(resolveRunIndex(claim));
                return runtime.birthOffset(claim.sub(uint(runtime.birthSchedule(0).w)), emitter.bursts.length);
              },
              resolveEmissionTime: claimIndex => {
                const run = runs.load(resolveRunIndex(claimIndex));
                return run.elapsed.div(run.duration.max(float(Number.EPSILON)));
              },
              resolveImpulseEffects: claimIndex => {
                const run = runs.load(resolveRunIndex(claimIndex));
                return {
                  scale: run.particle.speed,
                  speed: run.particle.distortionStrength,
                  mass: float(1),
                  alignmentDirection: undefined,
                };
              },
            });
          })().compute(context.buffers.capacity),
        );
      });

      nodes.push(
        Fn(() => {
          const run = runs.load(instanceIndex);
          If(run.active.notEqual(uint(0)).and(run.elapsed.greaterThanEqual(run.duration)), () => {
            run.active.assign(uint(0));
          });
        })().compute(runs.capacity),
      );

      this._gpuEventSubSystemComputeCache = { key: cacheKey, nodes };
    }

    this._gpuEventSubSystemComputeCache.nodes.forEach(node => renderer.compute(node));
  }

  _computeGPUSimulationPhase(
    context: GPUParticleUpdateContext,
    permanentModifiers: Array<Module | SpatialEffect>,
    transientPreMovementModifiers: Array<Module | SpatialEffect>,
    finalizers: Module[] = [],
  ): void {
    const buffers = context.buffers;
    if (!buffers.count) return;
    if (!isWebGPURenderer(this.system.sceneRenderer)) return;

    const computeNode = this._getGPUSimulationComputeNode(context,
      permanentModifiers, transientPreMovementModifiers, finalizers);

    this.system.sceneRenderer.compute(computeNode);
  }

  _computeGPUCollisionAndModifierPhases(
    context: GPUParticleUpdateContext,
    modifiers: Array<Module | SpatialEffect>,
  ): Array<Module | SpatialEffect> {
    const renderer = this.system.sceneRenderer;
    if (!isWebGPURenderer(renderer)) return modifiers;

    let pending: Array<Module | SpatialEffect> = [];
    this.system.spatialRuntime._gpuSpatialBuildSequence += 1;
    const builtGrids = new Set<ParticleSpatialGrid>();
    for (const modifier of modifiers) {
      const grid = modifier instanceof Module ? modifier.getParticleSpatialGrid(this.system) : undefined;
      if (!(modifier instanceof Collision) && !grid) {
        pending.push(modifier);
        continue;
      }

      if (pending.length > 0) {
        renderer.compute(this._getGPUStoredModifierNode(context, pending));
        pending = [];
      }

      if (grid && !builtGrids.has(grid)) {
        grid.rebuild(renderer, context.buffers, this.system.spatialRuntime._gpuSpatialBuildSequence);
        builtGrids.add(grid);
      }

      if (modifier instanceof Module) modifier.computeGPU(context, renderer, grid);

      if (modifier instanceof Collision) {
        if (modifier.hasGPUCollisionBackend()) {
          if (context.eventWriter && context.collisionEventWriter) {
            renderer.compute(this._getGPUCollisionDetectionNode(context, modifier));
            renderer.compute(this._getGPUCollisionResolutionNode(context, modifier));
            renderer.compute(this._getGPUCollisionEventNode(context, modifier));
          } else {
            renderer.compute(this._getGPUCollisionNode(context, modifier));
          }
        }
      } else {
        // Grid queries and custom events can consume all eight portable storage bindings.
        // Store their results before integration, which also binds the allocation buffer.
        renderer.compute(this._getGPUStoredModifierNode(context, [modifier]));
      }
    }

    return pending;
  }

  _getGPUStoredModifierNode(context: GPUParticleUpdateContext, modifiers: Array<Module | SpatialEffect>): ComputeNode {
    const buffers = context.buffers;
    const key = [
      'stored-modifiers',
      `events:${context.eventWriter?.version ?? 'none'}`,
      `buffer:${buffers.version}:${buffers.capacity}`,
      this._getGPUSpatialRegistrySignature(),
      this._getGPUModifierListSignature(modifiers),
    ].join('|');
    const cached = this._gpuModifierComputeCaches.get(key);
    if (cached) return cached.node;

    const node = Fn(() => {
      const particle = buffers.storage.createParticle(undefined, true);
      const wasAlive = particle.alive.toVar('modifierWasAlive');
      this._applyGPUModifiers(modifiers, particle, context);
      If(wasAlive.notEqual(uint(0)).and(particle.alive.equal(uint(0))), () => {
        context.eventWriter?.emitDeath(particle);
      });
      buffers.storage.storeParticle(particle);
    })().compute(buffers.count);
    this._gpuModifierComputeCaches.set(key, { key, node });
    return node;
  }

  _getGPUCollisionNode(context: GPUParticleUpdateContext, collision: Collision): ComputeNode {
    const buffers = context.buffers;
    const tagMask = this._getGPUTagMask(collision.tags);
    const key = [
      'collision',
      `buffer:${buffers.version}:${buffers.capacity}`,
      `events:${context.eventWriter?.version ?? 'none'}`,
      `collisionEvents:${context.collisionEventWriter?.version ?? 'none'}`,
      `module:${this._getObjectSignature(collision)}@${collision.version}`,
      `backend:${collision.backend ? this._getObjectSignature(collision.backend) : 'none'}`,
      `tags:${tagMask ?? 'all'}`,
    ].join('|');
    const cached = this._gpuModifierComputeCaches.get(key);
    if (cached) return cached.node;

    const node = Fn(() => {
      const particle = buffers.storage.createParticle(undefined, true);
      const matches =
        tagMask === undefined
          ? particle.alive.notEqual(uint(0))
          : particle.alive.notEqual(uint(0)).and(particle.tagMask.bitAnd(uint(tagMask)).notEqual(uint(0)));
      If(matches, () => {
        collision.modifyGPUCollision(particle, this._particleGPUContext(particle, context));
        buffers.storage.storeParticle(particle);
      });
    })().compute(buffers.count);
    this._gpuModifierComputeCaches.set(key, { key, node });
    return node;
  }

  _getGPUCollisionDetectionNode(context: GPUParticleUpdateContext, collision: Collision): ComputeNode {
    const buffers = context.buffers;
    const tagMask = this._getGPUTagMask(collision.tags);
    const key = [
      'collision-detection',
      `buffer:${buffers.version}:${buffers.capacity}`,
      `markers:${context.collisionEventWriter!.version}`,
      `module:${this._getObjectSignature(collision)}@${collision.version}`,
      `backend:${collision.backend ? this._getObjectSignature(collision.backend) : 'none'}`,
      `tags:${tagMask ?? 'all'}`,
    ].join('|');
    const cached = this._gpuModifierComputeCaches.get(key);
    if (cached) return cached.node;

    const node = Fn(() => {
      const particle = buffers.storage.createParticle(undefined, true);
      const matches =
        tagMask === undefined
          ? particle.alive.notEqual(uint(0))
          : particle.alive.notEqual(uint(0)).and(particle.tagMask.bitAnd(uint(tagMask)).notEqual(uint(0)));
      If(matches, () => collision.detectGPUCollision(particle, this._particleGPUContext(particle, context)));
    })().compute(buffers.count);
    this._gpuModifierComputeCaches.set(key, { key, node });
    return node;
  }

  _getGPUCollisionResolutionNode(context: GPUParticleUpdateContext, collision: Collision): ComputeNode {
    const buffers = context.buffers;
    const marker = context.collisionEventWriter!;
    const key = [
      'collision-resolution',
      `buffer:${buffers.version}:${buffers.capacity}`,
      `markers:${marker.version}`,
      `module:${this._getObjectSignature(collision)}@${collision.version}`,
    ].join('|');
    const cached = this._gpuModifierComputeCaches.get(key);
    if (cached) return cached.node;

    const node = Fn(() => {
      const particle = buffers.storage.createParticle(undefined, true);
      const event = marker.load(particle.index);
      If(particle.alive.notEqual(uint(0)).and(event.active), () => {
        collision.resolveGPUCollision(
          particle,
          this._particleGPUContext(particle, context),
          event.position,
          event.normal,
        );
        buffers.storage.storeParticle(particle);
      });
    })().compute(buffers.count);
    this._gpuModifierComputeCaches.set(key, { key, node });
    return node;
  }

  _getGPUCollisionEventNode(context: GPUParticleUpdateContext, collision: Collision): ComputeNode {
    const buffers = context.buffers;
    const marker = context.collisionEventWriter!;
    const key = [
      'collision-events',
      `buffer:${buffers.version}:${buffers.capacity}`,
      `events:${context.eventWriter!.version}`,
      `markers:${marker.version}`,
      `module:${this._getObjectSignature(collision)}@${collision.version}`,
    ].join('|');
    const cached = this._gpuModifierComputeCaches.get(key);
    if (cached) return cached.node;

    const node = Fn(() => {
      const particle = buffers.storage.createParticle(undefined, true);
      const event = marker.load(particle.index);
      If(particle.alive.notEqual(uint(0)).and(event.active), () => {
        context.eventWriter!.emitCollision(
          particle,
          event.point,
          event.normal,
          event.impulse,
          event.materialCopy,
          event.materialCopyU,
          event.materialCopyV,
        );
        marker.clear(particle.index);
      });
    })().compute(buffers.count);
    this._gpuModifierComputeCaches.set(key, { key, node });
    return node;
  }

  _getGPUSimulationComputeNode(
    context: GPUParticleUpdateContext,
    permanentModifiers: Array<Module | SpatialEffect>,
    transientPreMovementModifiers: Array<Module | SpatialEffect>,
    finalizers: Module[],
  ): ComputeNode {
    const buffers = context.buffers;
    const cacheKey = [
      'simulation',
      `buffer:${buffers.version}:${buffers.capacity}`,
      `count:${buffers.count}`,
      `gravityModifier:${this._getDynamicValueSignature(this.system.gravityModifier)}`,
      `events:${context.eventWriter?.version ?? 'none'}:${context.eventWriter?.capacity ?? 0}`,
      this._getGPUSpatialRegistrySignature(),
      `permanent:${this._getGPUModifierListSignature(permanentModifiers)}`,
      `transient:${this._getGPUModifierListSignature(transientPreMovementModifiers)}`,
      `finalizers:${this._getGPUModifierListSignature(finalizers)}`,
    ].join('|');

    const cached = this._gpuSimulationComputeCaches.get(cacheKey);
    if (cached) {
      this._gpuSimulationComputeCache = cached;
      return cached.node;
    }

    const computeNode = Fn(() => {
      const particle = buffers.storage.createParticle(undefined, true);

      If(particle.alive.notEqual(uint(0)), () => {
        const wasAlive = particle.alive.toVar('particleWasAlive');

        this._applyGPUModifiers(permanentModifiers, particle, context);

        const base = transientPreMovementModifiers.length > 0 ? this._snapshotGPUParticle(particle) : undefined;

        this._applyGPUModifiers(transientPreMovementModifiers, particle, context);

        const particleContext = this._particleGPUContext(particle, context);
        // Freeze the effective delta before consuming the encoded age.
        const effectiveDelta = particleContext.deltaTimeNode.toVar('effectiveDelta');
        this._integrateGPUParticle(particle, { ...context, deltaTimeNode: effectiveDelta });

        if (base) this._commitGPUTransientParticle(particle, base, effectiveDelta);
        particle.birthOffset?.assign(0);

        finalizers.forEach(module => this._applyGPUModifier(module, particle,
          { ...context, deltaTimeNode: effectiveDelta }, true));
        context.allocationWriter?.recordActive(particle);

        If(wasAlive.notEqual(uint(0)).and(particle.alive.equal(uint(0))), () => {
          context.eventWriter?.emitDeath(particle);
        });

        buffers.storage.storeParticle(particle);
      });
    })().compute(buffers.count);

    const entry = {
      key: cacheKey,
      node: computeNode,
    };
    this._gpuPipelineBuildCount += 1;
    this._gpuSimulationComputeCache = entry;
    this._gpuSimulationComputeCaches.set(cacheKey, entry);
    if (this._gpuSimulationComputeCaches.size > 32) {
      const oldestKey = this._gpuSimulationComputeCaches.keys().next().value as string | undefined;
      if (oldestKey !== undefined) {
        this._gpuSimulationComputeCaches.get(oldestKey)?.node.dispose?.();
        this._gpuSimulationComputeCaches.delete(oldestKey);
      }
    }

    return computeNode;
  }

  _computeGPURenderOutputPhase(
    source: GPUParticleBufferState,
    target: GPUParticleRenderBufferState,
    modifiers: Array<Module | SpatialEffect>,
    context: GPUParticleUpdateContext,
  ): void {
    if (!source.count) return;
    if (!isWebGPURenderer(this.system.sceneRenderer)) return;

    const computeNode = this._getGPURenderOutputComputeNode(source, target, modifiers, context);

    this.system.sceneRenderer.compute(computeNode);
  }

  _getGPURenderOutputComputeNode(
    source: GPUParticleBufferState,
    target: GPUParticleRenderBufferState,
    modifiers: Array<Module | SpatialEffect>,
    context: GPUParticleUpdateContext,
  ): ComputeNode {
    const cacheKey = [
      'render-output',
      `source:${source.version}:${source.capacity}`,
      `target:${target.version}:${target.capacity}`,
      `count:${source.count}`,
      this._getGPUSpatialRegistrySignature(),
      `modifiers:${this._getGPUModifierListSignature(modifiers)}`,
    ].join('|');

    if (this._gpuRenderOutputComputeCache?.key === cacheKey) {
      return this._gpuRenderOutputComputeCache.node;
    }

    this._gpuRenderOutputComputeCache?.node.dispose?.();

    const computeNode = Fn(() => {
      const particle = source.storage.createParticle(undefined, true);

      this._applyGPUModifiers(modifiers, particle, this._particleGPUContext(particle, context, true));

      target.storage.storeParticle(particle);
    })().compute(source.count);

    this._gpuRenderOutputComputeCache = {
      key: cacheKey,
      node: computeNode,
    };
    this._gpuPipelineBuildCount += 1;

    return computeNode;
  }

  _updateGPURuntimeUniforms(): void {
    this._gpuDeltaTimeNode.value = this.execution.deltaTime();
    this._gpuSkippedTimeNode.value = this.execution.skippedTime();
    this._gpuSkippedClockWrapNode.value = this.execution.skippedClockWrap();
    this._gpuElapsedTimeNode.value = this.execution.elapsedTime();
    this._gpuDurationNode.value = Math.max(this.system.duration, Number.EPSILON);
    this._gpuGravityNode.value.copy(this.system.gravity);
    this.system.updateWorldMatrix(true, false);
    const frame = this.system.getSimulationToWorldMatrix();
    this._gpuEmissionFrameNode.value.copy(frame).invert().multiply(this.system.matrixWorld);
    this._gpuSimulationToWorldNode.value.copy(frame);
    this._gpuWorldToSimulationNode.value.copy(frame).invert();
    this._gpuParentToSimulationNode.value
      .copy(frame)
      .invert()
      .multiply(this.system.subSystemParent?.getSimulationToWorldMatrix() ?? frame);

    if (this.system.simulationSpace === SimulationSpace.World) {
      this._gpuEmitterPositionNode.value.setFromMatrixPosition(this.system.matrixWorld);
    } else {
      this._gpuEmitterPositionNode.value.set(0, 0, 0);
    }
    this.system.emitters.forEach(emitter => emitter.updateGPUQuality(this.system.quality));
  }

  _getGPUModifierListSignature(modifiers: Array<Module | SpatialEffect>): string {
    const signatures: string[] = [
      `events:${Array.from(this.system.eventRuntime._eventTypes).join(',')}`,
      ...modifiers
        .filter((modifier): modifier is Module => modifier instanceof Module)
        .map(
          module =>
            `${module.events.join(',')}:${module.eventScope}:` +
            module
              .visibleSystems(this.system)
              .map(owner => `${owner.id}:${[...owner.eventRuntime._eventTypes]}`)
              .join('|'),
        ),
    ];
    for (let index = 0; index < modifiers.length; ) {
      const modifier = modifiers[index];
      const record =
        modifier instanceof SpatialEffect && isBatchableEffect(modifier)
          ? this._gpuSpatialRegistry?.getRecord(modifier)
          : undefined;
      if (!record || record.segmentId < 0) {
        signatures.push(this._getGPUModifierSignature(modifier));
        index += 1;
        continue;
      }

      signatures.push(`spatial-segment:${record.segmentId}`);
      index += 1;
      while (index < modifiers.length) {
        const next = modifiers[index];
        const nextRecord =
          next instanceof SpatialEffect && isBatchableEffect(next)
            ? this._gpuSpatialRegistry?.getRecord(next)
            : undefined;
        if (!nextRecord || nextRecord.segmentId !== record.segmentId) break;
        index += 1;
      }
    }
    return signatures.join(',');
  }

  _getGPUSpatialRegistrySignature(): string {
    const registry = this._gpuSpatialRegistry;
    if (!registry || registry.records.length <= 0) return 'spatial:none';
    const records = registry.records.map(record => record.effect.version).join(',');
    return `spatial:${registry.version}:${registry.signature}:${records}`;
  }

  _getGPUModifierSignature(modifier: Module | SpatialEffect): string {
    if (modifier instanceof SpatialEffect) modifier.updateWorldMatrix(true, false);
    const tagMask = this._getGPUTagMask(modifier.tags);
    const type = modifier instanceof Module ? 'module' : 'spatial';

    let instanceState = 'parameterized';
    if (modifier instanceof SpatialEffect) {
      const spatialEffect: SpatialEffect = modifier;
      const batchable =
        spatialEffect.supportsGPU && Boolean(spatialEffect.gpuSpatialType?.testGPU && spatialEffect.writeGPUParameters);
      if (!batchable) {
        instanceState = [spatialEffect.visible ? 1 : 0, spatialEffect.feather, spatialEffect.inverted ? 1 : 0].join(
          ':',
        );
      }
    }

    return [
      type,
      this._getObjectSignature(modifier),
      modifier.version,
      modifier.constructor.name,
      modifier.priority,
      tagMask === undefined ? 'all' : tagMask,
      instanceState,
    ].join(':');
  }

  _getDynamicValueSignature(value: DynamicValue<number> | undefined): string {
    if (value === undefined) return 'undefined';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'function') return 'function';
    if (Array.isArray(value)) return `array:${value.map(item => this._getDynamicValueSignature(item)).join(',')}`;
    if (value instanceof Set) {
      return `set:${Array.from(value)
        .map(item => this._getDynamicValueSignature(item))
        .join(',')}`;
    }
    if (typeof value === 'object' && value !== null) return `object:${this._getObjectSignature(value)}`;
    return typeof value;
  }

  _getObjectSignature(value: object): number {
    let id = this._gpuObjectIds.get(value);
    if (id === undefined) {
      id = this._nextGPUModifierId;
      this._nextGPUModifierId += 1;
      this._gpuObjectIds.set(value, id);
    }

    return id;
  }

  _disposeGPUComputeCaches(): void {
    this.subSystemPredicates.dispose(isWebGPURenderer(this.system.sceneRenderer)
      ? this.system.sceneRenderer : undefined);
    this.system.frameRuntime.invalidateGPUCompute();
    this._gpuLODCull?.node.dispose();
    this._gpuLODCull = undefined;
    this._gpuEmissionPrepareComputeCache?.nodes.forEach(node => node.dispose?.());
    this._gpuContinuousSubSystemComputeCache?.nodes.forEach(node => node.dispose?.());
    this._gpuEventSubSystemComputeCache?.nodes.forEach(node => node.dispose?.());
    this._gpuEmissionComputeCache?.nodes.forEach(node => node.dispose?.());
    this._gpuOldEmissionComputeCache?.nodes.forEach(node => node.dispose?.());
    this._gpuOldSelectionComputeCache?.nodes.forEach(node => node.dispose?.());
    this._gpuOldDeathEventComputeCache?.node.dispose?.();
    this._gpuAllocationSnapshotComputeCache?.node.dispose?.();
    this._gpuSpawnEventComputeCache?.node.dispose?.();
    this._gpuSimulationComputeCaches.forEach(cache => cache.node.dispose?.());
    this._gpuModifierComputeCaches.forEach(cache => cache.node.dispose?.());
    this._gpuRenderOutputComputeCache?.node.dispose?.();
    this._gpuEmissionPrepareComputeCache = undefined;
    this._gpuEmissionFinalizeComputeCache = undefined;
    this._gpuContinuousSubSystemComputeCache = undefined;
    this._gpuEventSubSystemComputeCache = undefined;
    this._gpuEmissionComputeCache = undefined;
    this._gpuOldEmissionComputeCache = undefined;
    this._gpuOldSelectionComputeCache = undefined;
    this._gpuOldDeathEventComputeCache = undefined;
    this._gpuAllocationSnapshotComputeCache = undefined;
    this._gpuSpawnEventComputeCache = undefined;
    this._gpuSimulationComputeCache = undefined;
    this._gpuSimulationComputeCaches.clear();
    this._gpuModifierComputeCaches.clear();
    this._gpuRenderOutputComputeCache = undefined;
  }

  _integrateGPUParticle(particle: GPUParticleLike, context: GPUParticleUpdateContext): void {
    const deltaTime = context.deltaTimeNode;
    const gravity = this._gpuGravityNode;
    const gravityModifier = this._gpuParameters.number(
      'gravityModifier.integrate',
      () => this.system.gravityModifier,
      particle.time,
      0,
      particle.index,
    );
    const nextVelocity = particle.velocity.add(gravity.mul(deltaTime.mul(gravityModifier)));
    const nextRealtime = particle.realtime.add(deltaTime.mul(1000));
    const nextTime = nextRealtime.div(1000).div(particle.lifetime);
    const step = deltaTime.mul(particle.speed);

    particle.velocity.assign(nextVelocity);
    particle.realtime.assign(nextRealtime);
    particle.time.assign(nextTime);

    particle.position.assign(particle.position.add(nextVelocity.mul(step)));
    particle.rotation.assign(particle.rotation.add(particle.angularVelocity.mul(step)));
    particle.scale.assign(particle.scale.add(particle.scalarVelocity.mul(step)));

    particle.velocity.assign(nextVelocity.add(particle.acceleration.mul(step)));
    particle.angularVelocity.assign(particle.angularVelocity.add(particle.angularAcceleration.mul(step)));
    particle.scalarVelocity.assign(particle.scalarVelocity.add(particle.scalarAcceleration.mul(step)));

    If(nextRealtime.greaterThan(particle.lifetime.mul(1000)), () => {
      particle.alive.assign(uint(0));
    });

  }

  _scheduleGPUAllocationReadback(allocationBuffer: GPUAllocationBufferState, renderer: WebGPURenderer): void {
    const now = performance.now();
    if (
      !renderer.backend ||
      typeof renderer.getArrayBufferAsync !== 'function' ||
      this._gpuAllocationReadbackPending ||
      now - this._lastGPUAllocationReadbackTime <
        (this.system.spatialEffectBoundsFiltering ? 1000 / Math.max(GlobalSettings.GPU_READBACK_RATE, 1) : 250)
    )
      return;

    this._gpuAllocationReadbackPending = true;
    this._lastGPUAllocationReadbackTime = now;
    const lifecycleGeneration = this._gpuLifecycleGeneration;
    void allocationBuffer
      .readback(renderer)
      .then(diagnostics => {
        if (lifecycleGeneration !== this._gpuLifecycleGeneration) return;
        this._gpuAllocationDiagnostics = diagnostics;
        if (
          this._gpuBuffers &&
          this._gpuBuffers.capacity < this.system.maxParticles &&
          (diagnostics.allocationFailures > 0 || diagnostics.recycledDeaths > 0)
        ) {
          const nextCapacity = Math.min(
            this.system.maxParticles,
            nextPowerOfTwo(this._gpuBuffers.capacity + diagnostics.allocationFailures),
          );
          if (this._gpuBuffers.grow(renderer, nextCapacity)) {
            this._gpuBuffers.ensureCount(nextCapacity);
            this._gpuAllocationBuffer = undefined;
            this._gpuRenderOutputBuffers = undefined;
            this._disposeGPUComputeCaches();
          }
        }
      })
      .catch(() => {
        // Diagnostics are best-effort and must never interrupt simulation.
      })
      .finally(() => {
        if (lifecycleGeneration === this._gpuLifecycleGeneration) {
          this._gpuAllocationReadbackPending = false;
        }
      });
  }

  _snapshotGPUParticle(particle: GPUParticleLike): GPUParticleLike {
    return {
      kill: particle.kill.bind(particle),
      emitEvent: particle.emitEvent.bind(particle),
      addTag: particle.addTag.bind(particle),
      removeTag: particle.removeTag.bind(particle),
      id: particle.id,
      isChild: particle.isChild,
      parent: particle.parent,
      root: particle.root,
      index: particle.index,
      position: particle.position.toVar('basePosition'),
      orbitCenter: particle.orbitCenter.toVar('baseOrbitCenter'),
      rotation: particle.rotation.toVar('baseRotation'),
      scale: particle.scale.toVar('baseScale'),
      velocity: particle.velocity.toVar('baseVelocity'),
      angularVelocity: particle.angularVelocity.toVar('baseAngularVelocity'),
      scalarVelocity: particle.scalarVelocity.toVar('baseScalarVelocity'),
      acceleration: particle.acceleration.toVar('baseAcceleration'),
      angularAcceleration: particle.angularAcceleration.toVar('baseAngularAcceleration'),
      scalarAcceleration: particle.scalarAcceleration.toVar('baseScalarAcceleration'),
      color: particle.color.toVar('baseColor'),
      speed: particle.speed.toVar('baseSpeed'),
      alpha: particle.alpha.toVar('baseAlpha'),
      mass: particle.mass.toVar('baseMass'),
      distortionStrength: particle.distortionStrength.toVar('baseDistortionStrength'),
      lifetime: particle.lifetime.toVar('baseLifetime'),
      time: particle.time.toVar('baseTime'),
      realtime: particle.realtime.toVar('baseRealtime'),
      alive: particle.alive.toVar('baseAlive'),
      tagMask: particle.tagMask.toVar('baseTagMask'),
      generation: particle.generation.toVar('baseGeneration'),
      lodPriority: particle.lodPriority,
      materialCopy: particle.materialCopy,
      materialCopyU: particle.materialCopyU,
      materialCopyV: particle.materialCopyV,
    };
  }

  _commitGPUTransientParticle(frame: GPUParticleLike, base: GPUParticleLike, deltaTime: Node<'float'>): void {
    const gravity = this._gpuGravityNode;
    const frameStep = deltaTime.mul(frame.speed);
    const baseStep = deltaTime.mul(base.speed);
    const gravityModifier = this._gpuParameters.number(
      'gravityModifier.transient',
      () => this.system.gravityModifier,
      base.time,
      0,
      base.index,
    );
    const gravityVelocity = gravity.mul(deltaTime.mul(gravityModifier));
    const frameVelocity = frame.velocity.sub(frame.acceleration.mul(frameStep));
    const frameAngularVelocity = frame.angularVelocity.sub(frame.angularAcceleration.mul(frameStep));
    const frameScalarVelocity = frame.scalarVelocity.sub(frame.scalarAcceleration.mul(frameStep));
    const baseVelocity = base.velocity.add(gravityVelocity);

    frame.lifetime.assign(base.lifetime);
    frame.position.assign(base.position.add(frameVelocity.mul(frameStep)));
    frame.orbitCenter.assign(base.orbitCenter);
    frame.rotation.assign(base.rotation.add(frameAngularVelocity.mul(frameStep)));
    frame.scale.assign(base.scale.add(frameScalarVelocity.mul(frameStep)));
    frame.velocity.assign(baseVelocity.add(base.acceleration.mul(baseStep)));
    frame.angularVelocity.assign(base.angularVelocity.add(base.angularAcceleration.mul(baseStep)));
    frame.scalarVelocity.assign(base.scalarVelocity.add(base.scalarAcceleration.mul(baseStep)));
    frame.acceleration.assign(base.acceleration);
    frame.angularAcceleration.assign(base.angularAcceleration);
    frame.scalarAcceleration.assign(base.scalarAcceleration);
    frame.speed.assign(base.speed);
    frame.mass.assign(base.mass);
    frame.distortionStrength.assign(base.distortionStrength);
    frame.color.assign(base.color);
    frame.alpha.assign(base.alpha);
    frame.tagMask.assign(base.tagMask);

    If(frame.realtime.greaterThan(frame.lifetime.mul(1000)), () => {
      frame.alive.assign(uint(0));
    });
  }

  _cloneParticlesForGPUReadback(particles: Particle[]): Particle[] {
    return particles.map(particle => {
      const clone = new Particle({
        position: particle.position,
        orbitCenter: particle.orbitCenter,
        rotation: particle.rotation,
        scale: particle.scale,
        velocity: particle.velocity,
        angularVelocity: particle.angularVelocity,
        scalarVelocity: particle.scalarVelocity,
        acceleration: particle.acceleration,
        angularAcceleration: particle.angularAcceleration,
        scalarAcceleration: particle.scalarAcceleration,
        speed: particle.speed,
        color: particle.color,
        tags: particle.tags ? [...particle.tags] : undefined,
        alpha: particle.alpha,
        lifetime: particle.lifetime,
        mass: particle.mass,
        distortionStrength: particle.distortionStrength,
      });

      clone.id = particle.id;
      clone.startTime = particle.startTime;
      clone.time = particle.time;
      clone.realtime = particle.realtime;
      clone.alive = particle.alive;
      clone.noise = { ...particle.noise };
      clone.data = particle.data;

      return clone;
    });
  }

  _particleGPUContext(
    particle: GPUParticleLike,
    context: GPUParticleUpdateContext,
    integrated = false,
  ): GPUParticleUpdateContext {
    const deltaTimeNode = integrated
      ? context.deltaTimeNode.min(particle.realtime.div(1000).max(0))
      : context.deltaTimeNode.sub(particle.birthOffset ?? float(0)).max(0);
    return { ...context, deltaTimeNode };
  }

  _applyGPUModifier(
    modifier: Module | SpatialEffect,
    particle: GPUParticleLike,
    updateContext: GPUParticleUpdateContext,
    finalize = false,
  ): void {
    const context = finalize ? updateContext : this._particleGPUContext(particle, updateContext);
    const alive = particle.alive.notEqual(uint(0));

    if (modifier instanceof Module) {
      const tagMask = this._getGPUTagMask(modifier.tags);
      const spatialGrid = modifier.getParticleSpatialGrid(this.system);
      const moduleContext = {
        ...context,
        events: modifier.gpuExecutionContext.events,
        spatialGrid,
      };
      const modifyParticle = () => {
        if (finalize) modifier.finalizeGPU(particle, context.deltaTimeNode, moduleContext, spatialGrid);
        else modifier.modifyGPU(particle, context.deltaTimeNode, moduleContext);
      };
      const modifySelectedParticle = modifier.conditionGPU
        ? () => If(modifier.conditionGPU!(particle, context.deltaTimeNode, moduleContext), modifyParticle)
        : modifyParticle;

      if (tagMask === undefined) {
        If(alive, modifySelectedParticle);
        return;
      }

      If(alive.and(particle.tagMask.bitAnd(uint(tagMask)).notEqual(uint(0))), modifySelectedParticle);
      return;
    }

    if (!modifier.visible) return;
    if (isBatchableEffect(modifier)) {
      const record = this._gpuSpatialRegistry?.getRecord(modifier);
      if (record) {
        this._applyGPUSpatialRecord(record, particle, context);
        return;
      }
    }

    const tagMask = this._getGPUTagMask(modifier.tags);
    const applySpatialEffect = () => {
      const strength = modifier.testGPU(particle, context);

      If(strength.greaterThan(float(0)), () => {
        this._modifyGPUSpatialEffect(modifier, particle, strength, () => {
          modifier.modifyGPU(particle, context.deltaTimeNode, context, strength);
        });
      });
    };

    if (tagMask === undefined) {
      If(alive, applySpatialEffect);
      return;
    }

    If(alive.and(particle.tagMask.bitAnd(uint(tagMask)).notEqual(uint(0))), applySpatialEffect);
  }

  _configureParticleGPU(particle: GPUParticleLike, context: GPUParticleUpdateContext): void {
    const registeredTagMask = (tag: Tag): number => {
      const index = this._gpuTagRegistry.get(tag);
      if (index === undefined) throw new Error(`GPU particle tag "${tag}" is not registered in this system.`);
      return (2 ** index) >>> 0;
    };
    particle.addTag = tag => {
      particle.tagMask.assign(particle.tagMask.bitOr(uint(registeredTagMask(tag))));
    };
    particle.removeTag = tag => {
      particle.tagMask.assign(particle.tagMask.bitAnd(uint(~registeredTagMask(tag) >>> 0)));
    };
    particle.emitEvent = (event, payload) => {
      if (Array.isArray(payload) && payload.length > 3)
        throw new Error('GPU custom event payload accepts at most three vec4 values (12 floats).');
      const type = this.system.eventRuntime._eventTypes.get(event);
      if (type !== undefined) context.eventWriter?.emitParticleEvent(type, particle, payload);
    };
  }

  _applyGPUModifiers(
    modifiers: Array<Module | SpatialEffect>,
    particle: GPUParticleLike,
    context: GPUParticleUpdateContext,
  ): void {
    this._configureParticleGPU(particle, context);
    for (let index = 0; index < modifiers.length; ) {
      const modifier = modifiers[index];
      const firstRecord =
        modifier instanceof SpatialEffect && isBatchableEffect(modifier)
          ? this._gpuSpatialRegistry?.getRecord(modifier)
          : undefined;
      if (!firstRecord || !this._gpuSpatialRegistry) {
        this._applyGPUModifier(modifier, particle, context);
        index += 1;
        continue;
      }

      let nextIndex = index + 1;
      while (nextIndex < modifiers.length) {
        const next = modifiers[nextIndex];
        if (!(next instanceof SpatialEffect) || !isBatchableEffect(next)) break;
        const record = this._gpuSpatialRegistry.getRecord(next);
        if (!record || record.segmentId !== firstRecord.segmentId) break;
        nextIndex += 1;
      }

      this._gpuSpatialRegistry.applySegment(
        firstRecord.segmentId,
        particle,
        this._particleGPUContext(particle, context),
      );
      index = nextIndex;
    }
  }

  _applyGPUSpatialRecord(
    record: GPUSpatialEffectRecord,
    particle: GPUParticleLike,
    context: GPUParticleUpdateContext,
  ): void {
    const registry = this._gpuSpatialRegistry;
    if (!registry || !record.enabled) return;

    const type = registry.types[record.typeId];
    if (!type) return;

    const alive = particle.alive.notEqual(uint(0));
    const tagMatch =
      record.tagMask === 0 ? alive : alive.and(particle.tagMask.bitAnd(uint(record.tagMask)).notEqual(uint(0)));
    const applySpatialEffect = () => {
      const strength = record.effect.testGPU(particle, context);

      If(strength.greaterThan(float(0)), () => {
        this._modifyGPUSpatialEffect(record.effect, particle, strength, () => {
          type.modifyGPU(
            particle,
            context.deltaTimeNode,
            context,
            registry.createParameterAccessor(type, uint(record.parameterOffset)),
            strength,
          );
        });
      });
    };

    If(tagMatch, applySpatialEffect);
  }

  _modifyGPUSpatialEffect(
    effect: SpatialEffect,
    particle: GPUParticleLike,
    strength: Node<'float'>,
    modify: () => void,
  ): void {
    if (!effect.automaticFeather) {
      modify();
      return;
    }

    const before = this._snapshotGPUParticle(particle);
    modify();
    const blendFloat = (start: Node<'float'>, end: Node<'float'>) => mix(start, end, strength);
    const blendVector = (start: Node<'vec3'>, end: Node<'vec3'>) => mix(start, end, strength);

    particle.lifetime.assign(blendFloat(before.lifetime, particle.lifetime));
    particle.position.assign(blendVector(before.position, particle.position));
    particle.orbitCenter.assign(blendVector(before.orbitCenter, particle.orbitCenter));
    particle.rotation.assign(blendVector(before.rotation, particle.rotation));
    particle.scale.assign(blendVector(before.scale, particle.scale));
    particle.velocity.assign(blendVector(before.velocity, particle.velocity));
    particle.angularVelocity.assign(blendVector(before.angularVelocity, particle.angularVelocity));
    particle.scalarVelocity.assign(blendVector(before.scalarVelocity, particle.scalarVelocity));
    particle.acceleration.assign(blendVector(before.acceleration, particle.acceleration));
    particle.angularAcceleration.assign(blendVector(before.angularAcceleration, particle.angularAcceleration));
    particle.scalarAcceleration.assign(blendVector(before.scalarAcceleration, particle.scalarAcceleration));
    particle.speed.assign(blendFloat(before.speed, particle.speed));
    particle.mass.assign(blendFloat(before.mass, particle.mass));
    particle.distortionStrength.assign(blendFloat(before.distortionStrength, particle.distortionStrength));
    particle.color.assign(blendVector(before.color, particle.color));
    particle.alpha.assign(blendFloat(before.alpha, particle.alpha));
  }

  _beginGPUDebugFrame(modules: Module[]): number | undefined {
    this._gpuDebugFrame += 1;

    if (!this._isGPUDebugEnabled()) return undefined;

    const interval = Math.max(1, this.system.gpuDebugInterval || GlobalSettings.GPU_DEBUG_INTERVAL);
    if (this._gpuDebugFrame % interval !== 0) return undefined;

    this._gpuDebugActiveFrame = this._gpuDebugFrame;
    this._logGPUDebug('begin', {
      deltaTime: this.execution.deltaTime(),
      particleCount: this.system.particles.length,
      renderer: this.system.sceneRenderer?.constructor.name,
      modules: this._describeGPUModules(modules),
      tagRegistry: Array.from(this._gpuTagRegistry.entries()),
      tagOverflow: this._gpuTagOverflow,
    });

    return this._gpuDebugFrame;
  }

  _endGPUDebugFrame(frame: number | undefined): void {
    if (frame === undefined) return;

    this._logGPUDebug('end', {
      particleCount: this.system.particles.length,
      sample: this._sampleGPUParticles(this.system.particles),
    });

    if (this._gpuDebugActiveFrame === frame) {
      this._gpuDebugActiveFrame = undefined;
    }
  }

  _isGPUDebugEnabled(): boolean {
    return this.system.gpuDebug || GlobalSettings.GPU_DEBUG;
  }

  _logGPUDebug(message: string, data?: unknown): void {
    if (this._gpuDebugActiveFrame === undefined) return;

    const prefix = `[RZMPS GPU frame ${this._gpuDebugActiveFrame}] ${message}`;
    if (data === undefined) {
      console.debug(prefix);
      return;
    }

    console.debug(prefix, data);
  }

  _describeGPUModules(modules: Module[]): Array<{
    name: string;
    priority: number;
    tags?: Tag[];
    supportsGPU: boolean;
  }> {
    return modules.map(module => ({
      name: module.constructor.name,
      priority: module.priority,
      tags: module.tags ? [...module.tags] : undefined,
      supportsGPU: module.supportsGPU,
    }));
  }

  _describeGPUModifiers(modifiers: Array<Module | SpatialEffect>): Array<{
    name: string;
    priority: number;
    tags?: Tag[];
    supportsGPU: boolean;
    type: 'module' | 'spatialEffect';
  }> {
    return modifiers.map(modifier => ({
      name: modifier.constructor.name,
      priority: modifier.priority,
      tags: modifier.tags ? [...modifier.tags] : undefined,
      supportsGPU: modifier.supportsGPU,
      type: modifier instanceof Module ? 'module' : 'spatialEffect',
    }));
  }

  _sampleGPUParticles(particles: Particle[]): Array<{
    index: number;
    id: string;
    alive: boolean;
    tags?: Tag[];
    tagMask: number;
    time: number;
    realtime: number;
    lifetime: number;
    position: number[];
    rotation: number[];
    scale: number[];
    velocity: number[];
    angularVelocity: number[];
    scalarVelocity: number[];
    speed: number;
    alpha: number;
    distortionStrength: number;
  }> {
    return particles.slice(0, 3).map((particle, index) => ({
      index,
      id: particle.id,
      alive: particle.alive,
      tags: particle.tags ? [...particle.tags] : undefined,
      tagMask: this._getParticleGPUTagMask(particle),
      time: this._debugNumber(particle.time),
      realtime: this._debugNumber(particle.realtime),
      lifetime: this._debugNumber(particle.lifetime),
      position: this._debugVector(particle.position),
      rotation: this._debugVector(particle.rotation),
      scale: this._debugVector(particle.scale),
      velocity: this._debugVector(particle.velocity),
      angularVelocity: this._debugVector(particle.angularVelocity),
      scalarVelocity: this._debugVector(particle.scalarVelocity),
      speed: this._debugNumber(particle.speed),
      alpha: this._debugNumber(particle.alpha),
      distortionStrength: this._debugNumber(particle.distortionStrength),
    }));
  }

  _debugVector(vector: THREE.Vector3): number[] {
    return [this._debugNumber(vector.x), this._debugNumber(vector.y), this._debugNumber(vector.z)];
  }

  _debugNumber(value: number): number {
    if (!Number.isFinite(value)) return value;
    return Number(value.toFixed(4));
  }

  _prepareGPUTagRegistry(modules: Module[], spatialEffects: SpatialEffect[] = []): void {
    this._gpuTagRegistry.clear();
    this._gpuTagOverflow = false;

    const root = this.execution.eventRoot();

    const registerSystem = (system: ParticleSystem): void => {
      const systemModules =
        system === this.system ? modules : system.modules.flatMap(module => module.withDependents());
      const systemSpatialEffects = system === this.system ? spatialEffects : system.spatialEffects;

      systemModules.forEach(module => {
        module.tags?.forEach(tag => this._registerGPUTag(tag));
      });
      systemSpatialEffects.forEach(spatialEffect => {
        spatialEffect.tags?.forEach(tag => this._registerGPUTag(tag));
      });
      system.emitters.forEach(emitter => {
        emitter.tags?.forEach(tag => this._registerGPUTag(tag));
        system.getEmitterOptions(emitter).tags?.forEach(tag => this._registerGPUTag(tag));
      });
      system.renderers.forEach(renderer => {
        renderer.tags?.forEach(tag => this._registerGPUTag(tag));
        renderer.selectionTags.forEach(tag => this._registerGPUTag(tag));
      });
      system.subSystems.forEach((options, child) => {
        options.tags?.forEach(tag => this._registerGPUTag(tag));
        registerSystem(child);
      });
    };

    registerSystem(root);
  }

  _registerGPUTag(tag: Tag): void {
    if (this._gpuTagRegistry.has(tag) || this._gpuTagOverflow) return;
    if (this._gpuTagRegistry.size >= 32) {
      this._gpuTagOverflow = true;
      return;
    }

    this._gpuTagRegistry.set(tag, this._gpuTagRegistry.size);
  }

  _getParticleGPUTagMask(particle: Particle): number {
    return this._getGPUTagMask(particle.tags) ?? 0;
  }

  _getGPUEmitterTagMasks(emitter: Emitter): number[] {
    return emitter.tags?.map(tag => this._getGPUTagMask([tag]) ?? 0) ?? [];
  }

  _getGPUTagMask(tags?: Tag[]): number | undefined {
    if (!tags) return undefined;

    let mask = 0;
    tags.forEach(tag => {
      const index = this._gpuTagRegistry.get(tag);
      if (index === undefined) return;
      mask += 2 ** index;
    });

    return mask >>> 0;
  }

  _getGPUTagsFromMask(mask: number): Tag[] | undefined {
    if (!mask) return undefined;
    const tags = Array.from(this._gpuTagRegistry.entries())
      .filter(([, index]) => (mask & (2 ** index)) !== 0)
      .map(([tag]) => tag);
    return tags.length > 0 ? tags : undefined;
  }

  _usesGPUStableParticleSlots(): boolean {
    return this._isGPUProcessingActive || (this.system.gpuProcessing && isWebGPURenderer(this.system.sceneRenderer));
  }

  _shouldRequestGPUReadback(): boolean {
    const rate = Math.max(0, GlobalSettings.GPU_READBACK_RATE);
    if (rate <= 0) return false;

    const interval = 1000 / rate;
    return performance.now() - this._lastGPUReadbackRequestTime >= interval;
  }

  _hasGPUEventConsumers(): boolean {
    if (this.execution.sharedEvents() || this.system.eventRuntime._eventObservers.size) return true;
    if (
      this.system.eventRuntime._deathListeners.length > 0 ||
      this.system.eventRuntime._spawnListeners.length > 0 ||
      this.system.eventRuntime._collisionListeners.length > 0
    )
      return true;

    for (const options of this.system.subSystems.values()) {
      if (options.emitOnDeath || options.emitOnSpawn || options.emitOnCollision || eventNames(options.onEvent).length)
        return true;
    }

    return false;
  }

  _hasGPUNativeSubSystemConsumers(): boolean {
    for (const [subSystem, options] of this.system.subSystems) {
      if (subSystem.gpuSimulation._canUpdateAsGPUSubSystem(this.system, options)) return true;
    }
    return false;
  }

  _canUpdateAsGPUSubSystem(parent: ParticleSystem, options: SubSystemOptions): boolean {
    if (!parent || !options || !parent.gpuSimulation._gpuBuffers || !parent.gpuSimulation._isGPUProcessingActive)
      return false;
    if (!this.system.gpuProcessing || !isWebGPURenderer(this.system.sceneRenderer ?? parent.sceneRenderer))
      return false;
    if (typeof options.shouldEmit === 'function' && !options.shouldEmitGPU) return false;
    if (!this.system.emitters.length) return false;

    return (
      options.emitContinuous ||
      options.emitOnDeath ||
      options.emitOnSpawn ||
      options.emitOnCollision ||
      eventNames(options.onEvent).length > 0
    );
  }

  _canHandleNativeGPUEvent(parent: ParticleSystem, options: SubSystemOptions, event: string): boolean {
    const renderer = this.system.sceneRenderer ?? this.execution.eventRoot().sceneRenderer;
    if (
      !this.system.gpuProcessing ||
      !parent.gpuProcessing ||
      !isWebGPURenderer(renderer) ||
      (typeof options.shouldEmit !== 'boolean' && !options.shouldEmitGPU) ||
      !this.system.modules.every(module => module.supportsGPU)
    )
      return false;
    const gpuHandler = !Array.isArray(options.onEvent) && options.onEvent?.gpu?.[event];
    return !cpuEventHandler(options.onEvent, event) || !!gpuHandler;
  }

  _needsCPUEventReadback(): boolean {
    if (
      [...this.system.eventRuntime._eventObservers].some(
        observer => !observer.receiver || (observer.receiver instanceof EventReceiver && !observer.receiver.gpuNative),
      )
    )
      return true;
    if (
      this.system.eventRuntime._deathListeners.length ||
      this.system.eventRuntime._spawnListeners.length ||
      this.system.eventRuntime._collisionListeners.length
    )
      return true;
    const needsReadback = (owner: ParticleSystem): boolean =>
      owner.emitters.some(emitter => {
        if (!emitter.visibleSystems(owner).includes(this.system)) return false;
        const options = owner.getEmitterOptions(emitter);
        return [...this.system.eventRuntime._eventTypes.keys()].some(
          name =>
            subscribes(options, name) && !owner.gpuSimulation._canHandleNativeGPUEvent(this.system, options, name),
        );
      }) || [...owner.subSystems.keys()].some(needsReadback);
    return needsReadback(this.execution.eventRoot());
  }

  _getSubSystemGPUOptionsSignature(options: SubSystemOptions): string {
    return [
      JSON.stringify(options.eventScope),
      options.emitContinuous,
      options.emitOnDeath,
      options.emitOnSpawn,
      options.emitOnCollision,
      options.ratio,
      options.inheritScale,
      options.inheritLifetime,
      options.inheritColor,
      options.inheritAlpha,
      options.inheritMass,
      options.inheritVelocity,
      options.impulseAffectsCount,
      options.impulseAffectsScale,
      options.impulseAffectsSpeed,
      options.impulseAffectsLifetime,
      options.impulseAffectsMass,
      options.impulseAffectsAlignment,
      options.impulseThreshold,
      String(options.shouldEmit),
      options.shouldEmitGPU ? this._getObjectSignature(options.shouldEmitGPU) : 'none',
      options.tags?.map(tag => this._gpuTagRegistry.get(tag)).join(','),
      eventNames(options.onEvent)
        .map(name => {
          const handler = !Array.isArray(options.onEvent) && options.onEvent?.gpu?.[name];
          return [
            name,
            this.system.subSystemParent?.eventRuntime._eventTypes.get(name),
            handler ? this._getObjectSignature(handler) : '',
            !!cpuEventHandler(options.onEvent, name),
          ].join(':');
        })
        .join(','),
    ].join(':');
  }

  _getInitialGPUBufferCapacity(): number {
    const required = Math.max(
      GlobalSettings.GPU_INITIAL_BUFFER_SIZE,
      this.system.particles.length,
      this.system.emissionRuntime._stagedBirths.length,
      this.system.estimateParticleCount(),
      1,
    );
    return Math.min(nextPowerOfTwo(required), Math.max(this.system.maxParticles, 1));
  }

  _acquireGPUEventBuffer(renderer: WebGPURenderer) {
    return this.system.eventRuntime.acquireBuffer(
      renderer,
      Math.min(GlobalSettings.GPU_EVENT_BUFFER_CAPACITY, Math.max(32, this.system.maxParticles * 3)),
      () => {
        this._gpuResourceBuildCount += 1;
      },
    );
  }

  _acquireGPUCollisionEventBuffer(renderer: WebGPURenderer) {
    return this.system.eventRuntime.acquireCollisionBuffer(
      renderer,
      Math.max(this._gpuBuffers?.capacity ?? 1, 1),
      () => {
        this._gpuResourceBuildCount += 1;
      },
    );
  }

  _acquireGPUAllocationBuffer(renderer: WebGPURenderer): GPUAllocationBufferState {
    const capacity = Math.max(this._gpuBuffers?.capacity ?? 1, 1);
    if (!this._gpuAllocationBuffer || this._gpuAllocationBuffer.capacity !== capacity) {
      this._gpuResourceBuildCount += 1;
      this._gpuAllocationBuffer = new GPUAllocationBufferState(capacity);
    }

    this._gpuAllocationBuffer.initialize(renderer);
    return this._gpuAllocationBuffer;
  }

  _acquireGPUEmitterInstances(
    kind: 'standalone' | 'continuous' | 'event',
    capacity: number,
    emitters: Emitter[],
    renderer: WebGPURenderer,
  ): GPUEmitterInstanceBufferState {
    const requiredCapacity = Math.max(1, capacity);
    const maxBurstCount = emitters.reduce((max, emitter) => Math.max(max, emitter.bursts.length), 0);
    const requiredBurstWordCount = Math.max(1, Math.ceil(maxBurstCount / 32));
    const field =
      kind === 'standalone'
        ? '_gpuStandaloneEmitterInstances'
        : kind === 'continuous'
          ? '_gpuContinuousEmitterInstances'
          : '_gpuEventEmitterInstances';
    let instances = this[field];
    if (
      !instances ||
      instances.capacity !== requiredCapacity ||
      instances.burstWordCount !== requiredBurstWordCount ||
      instances.maxBurstCount !== maxBurstCount
    ) {
      this._gpuResourceBuildCount += 1;
      instances = new GPUEmitterInstanceBufferState(requiredCapacity, maxBurstCount);
      this[field] = instances;
      this._gpuEmissionPrepareComputeCache?.nodes.forEach(node => node.dispose?.());
      this._gpuEmissionPrepareComputeCache = undefined;
      this._gpuEmissionFinalizeComputeCache?.nodes.forEach(node => node.dispose?.());
      this._gpuEmissionFinalizeComputeCache = undefined;
      this._gpuEmissionComputeCache?.nodes.forEach(node => node.dispose?.());
      this._gpuEmissionComputeCache = undefined;
      this._gpuOldEmissionComputeCache?.nodes.forEach(node => node.dispose?.());
      this._gpuOldEmissionComputeCache = undefined;
      this._gpuOldSelectionComputeCache?.nodes.forEach(node => node.dispose?.());
      this._gpuOldSelectionComputeCache = undefined;
      this._gpuContinuousSubSystemComputeCache?.nodes.forEach(node => node.dispose?.());
      this._gpuContinuousSubSystemComputeCache = undefined;
      this._gpuEventSubSystemComputeCache?.nodes.forEach(node => node.dispose?.());
      this._gpuEventSubSystemComputeCache = undefined;
    }

    instances.initialize(renderer);
    return instances;
  }

  _acquireGPUEmissionRuns(capacity: number, renderer: WebGPURenderer): GPUEmissionRunBufferState {
    const requiredCapacity = Math.max(1, capacity);
    if (!this._gpuEmissionRuns || this._gpuEmissionRuns.capacity !== requiredCapacity) {
      this._gpuResourceBuildCount += 1;
      this._gpuEmissionRuns?.snapshots.dispose(renderer);
      this._gpuEmissionRuns = new GPUEmissionRunBufferState(requiredCapacity);
      this._gpuEventSubSystemComputeCache?.nodes.forEach(node => node.dispose?.());
      this._gpuEventSubSystemComputeCache = undefined;
    }

    this._gpuEmissionRuns.initialize(renderer);
    return this._gpuEmissionRuns;
  }

  _getGPUCullingModeCode(): number {
    return this.system.maxCullingMode === MaxCulling.Old ? 1 : 0;
  }

  _scheduleGPUEventReadback(buffer: GPUEventBufferState, renderer: WebGPURenderer): void {
    this.system.eventRuntime.scheduleReadback(buffer, renderer, this._eventReadbackExecution());
  }

  _flushGPUEventBatches(): void {
    this.system.eventRuntime.flushGPU(this._eventReadbackExecution());
  }

  _dispatchGPUDeathEvent(slot: number, generation: number, particle: Particle): void {
    const key = this._getGPUParticleSlotKey(slot, generation);
    if (this.system.eventRuntime._gpuDeliveredDeathEvents.has(key)) return;

    this.system.eventRuntime._gpuDeliveredDeathEvents.add(key);

    const current = this.system.particles[slot];
    if (current && this._gpuParticleSlotGenerations[slot] === generation && current.id === particle.id) {
      current.alive = false;
      current.realtime = particle.realtime;
      current.time = particle.time;
      current.position.copy(particle.position);
      current.orbitCenter.copy(particle.orbitCenter);
      current.rotation.copy(particle.rotation);
      current.scale.copy(particle.scale);
      current.velocity.copy(particle.velocity);
      current.angularVelocity.copy(particle.angularVelocity);
      current.scalarVelocity.copy(particle.scalarVelocity);
      current.acceleration.copy(particle.acceleration);
      current.angularAcceleration.copy(particle.angularAcceleration);
      current.scalarAcceleration.copy(particle.scalarAcceleration);
      current.color.copy(particle.color);
      current.alpha = particle.alpha;
      current.mass = particle.mass;
      current.distortionStrength = particle.distortionStrength;
      current.lifetime = particle.lifetime;
      current.speed = particle.speed;
      current.cache();
      this._gpuDirtyParticleSlots.add(slot);
    }

    this.execution.particleDeath(particle, true);
  }

  public async selectiveReadback(
    limit = Number.POSITIVE_INFINITY,
    fields?: readonly GPUParticleReadbackField[],
  ): Promise<GPUSelectiveReadbackResult[]> {
    return this._readbackGPUParticles(this._createReadbackRequests(limit, fields));
  }

  async _readbackGPUParticles(requests: GPUSelectiveReadbackRequest[]): Promise<GPUSelectiveReadbackResult[]> {
    if (!this._gpuBuffers || requests.length === 0) return [];

    const renderer = this.system.sceneRenderer;
    if (!isWebGPURenderer(renderer) || typeof renderer.getArrayBufferAsync !== 'function') {
      throw new Error('Selective GPU particle readback requires a WebGPU renderer with async buffer readback.');
    }

    let slot = this._gpuSelectiveReadbacks.find(
      candidate => !candidate.pending && candidate.state.capacity >= requests.length,
    );
    if (!slot) {
      const reusable = this._gpuSelectiveReadbacks.find(candidate => !candidate.pending);
      if (reusable) {
        reusable.state = new GPUSelectiveReadbackState(Math.max(1, requests.length));
        slot = reusable;
      } else if (this._gpuSelectiveReadbacks.length < GlobalSettings.GPU_SELECTIVE_READBACK_POOL_SIZE) {
        slot = {
          state: new GPUSelectiveReadbackState(Math.max(1, requests.length)),
          pending: false,
        };
        this._gpuSelectiveReadbacks.push(slot);
      } else {
        this._gpuSelectiveReadbackOverflowCount += 1;
        return [];
      }
    }

    const startedAt = performance.now();
    const lifecycleGeneration = this._gpuLifecycleGeneration;
    slot.pending = true;
    try {
      slot.state.setRequests(requests);
      slot.state.gather(renderer, this._gpuBuffers);
      const results = await slot.state.readback(renderer);
      if (lifecycleGeneration !== this._gpuLifecycleGeneration) return [];
      results.forEach(result => {
        result.particle.setEventOwner(this.system);
        result.particle.tags = this._getGPUTagsFromMask(result.tagMask);
      });
      this._gpuSelectiveReadbackBytes += slot.state.readbackByteLength;
      this._gpuSelectiveReadbackLatencyMs = performance.now() - startedAt;
      return results;
    } catch (error) {
      // Reset/destroy can invalidate a buffer while its asynchronous map is in
      // flight. Chromium also reports device/context teardown as AbortError.
      // Both cases cancel this optional observation rather than the simulation.
      if (
        lifecycleGeneration !== this._gpuLifecycleGeneration ||
        this.system.destroyed ||
        (error as { name?: unknown })?.name === 'AbortError'
      )
        return [];
      throw error;
    } finally {
      slot.pending = false;
    }
  }

  _createReadbackRequests(
    limit = Number.POSITIVE_INFINITY,
    fields?: readonly GPUParticleReadbackField[],
  ): GPUSelectiveReadbackRequest[] {
    if (!this._gpuBuffers) return [];

    const max = Math.min(this._gpuBuffers.count, Math.max(0, Math.floor(limit)));
    const requests: GPUSelectiveReadbackRequest[] = [];

    for (let slot = 0; slot < max; slot += 1) {
      const generation = this._gpuParticleSlotGenerations[slot] ?? 0;
      const gpuNativeSlot = this.execution.nativeEmission() && generation <= 0;
      if (generation <= 0 && !gpuNativeSlot) continue;

      requests.push({
        slot,
        generation: gpuNativeSlot ? 0 : generation,
        fields,
        identity: gpuNativeSlot
          ? undefined
          : (this._getGPUParticleIdentity(slot, generation) ?? this.system.particles[slot]),
      });
    }

    return requests;
  }

  _getGPUParticleSlotGeneration(particle: Particle, index: number): number {
    if (this._gpuParticleSlotIds[index] !== particle.id) {
      this._gpuParticleSlotGenerations[index] = (this._gpuParticleSlotGenerations[index] ?? 0) + 1;
      this._gpuParticleSlotIds[index] = particle.id;
    }

    const generation = this._gpuParticleSlotGenerations[index] || 1;
    this._gpuParticleSlotIdentities.set(this._getGPUParticleSlotKey(index, generation), {
      particle: particle.clone(),
      generation,
    });

    return generation;
  }

  _getGPUParticleIdentity(slot: number, generation: number): Particle | undefined {
    return this._gpuParticleSlotIdentities.get(this._getGPUParticleSlotKey(slot, generation))?.particle;
  }

  _getGPUParticleSlotKey(slot: number, generation: number): string {
    return `${slot}:${generation}`;
  }

  _uploadDirtyGPUParticleSlots(buffer: GPUParticleBufferState): void {
    this._gpuDirtyParticleSlots.forEach(index => {
      const particle = this.system.particles[index];
      if (!particle) return;

      buffer.uploadIndex(
        index,
        particle,
        value => this._getParticleGPUTagMask(value),
        (value, slot) => this._getGPUParticleSlotGeneration(value, slot),
      );
    });
  }

  _markExpiredGPUParticleSlots(): void {
    this.system.particles.forEach((particle, index) => {
      if (!particle.alive) return;
      if (particle.realtime <= particle.lifetime * 1000) return;

      particle.alive = false;
      this._gpuDirtyParticleSlots.add(index);
      this.execution.notifyDeath(particle);
    });
  }

  _applyGPUReadbackDeaths(particles: Particle[], wasAlive: boolean[]): void {
    particles.forEach((particle, index) => {
      if (particle.alive && particle.realtime > particle.lifetime * 1000) {
        particle.alive = false;
        this._gpuDirtyParticleSlots.add(index);
      }

      if (wasAlive[index] && !particle.alive && particle.lodPriority < this.system.quality) {
        this._gpuDirtyParticleSlots.add(index);
      }
    });
  }

  _flushTargetedGPUEvents(): void {
    if (!this.system.eventRuntime._pendingGPUEvents.length) return;
    const events = this.system.eventRuntime._pendingGPUEvents.splice(0);
    const requests = Array.from(
      new Map(
        events.map(e => [
          `${e.slot}:${e.generation}`,
          {
            slot: e.slot,
            generation: e.generation,
            identity: this._getGPUParticleIdentity(e.slot, e.generation),
          },
        ]),
      ).values(),
    );
    const lifecycle = this._gpuLifecycleGeneration;
    void this._readbackGPUParticles(requests)
      .then(results => {
        if (lifecycle !== this._gpuLifecycleGeneration) return;
        // A busy bounded readback pool retries the entire batch; events are never coalesced.
        if (!results.length) {
          this.system.eventRuntime._pendingGPUEvents.unshift(...events);
          return;
        }
        const snapshots = new Map(results.filter(r => r.valid).map(r => [`${r.slot}:${r.generation}`, r.particle]));
        for (const event of events) {
          const particle = snapshots.get(`${event.slot}:${event.generation}`);
          if (particle) this.execution.dispatchSourceEvent(particle, event.event, event.data);
        }
      })
      .catch(error => {
        console.warn('RZMPS: GPU event targeting readback failed.', error);
      });
  }

  _readGPUContinuousSources(): void {
    const lifecycle = this._gpuLifecycleGeneration;
    this._gpuContinuousSourcesReadbackPending = true;
    const requests = Array.from({ length: this._gpuBuffers!.count }, (_, slot) => ({ slot, generation: 0 }));
    void this._readbackGPUParticles(requests)
      .then(results => {
        if (lifecycle !== this._gpuLifecycleGeneration) return;
        if (!results.length && requests.length) return; // Keep contexts while the bounded pool is busy.
        const next = results
          .filter(result => result.valid)
          .map(result => {
            const identity = this._getGPUParticleIdentity(result.slot, result.generation);
            if (identity) result.particle.id = identity.id;
            return result.particle;
          });
        const live = new Set(next.map(p => p.id));
        for (const old of this._gpuContinuousSourceSnapshots) {
          if (!live.has(old.id))
            this.system.subSystems.forEach((options, child) => {
              if (!child.gpuSimulation._canUpdateAsGPUSubSystem(this.system, options))
                child.emitters.forEach(emitter => emitter.clearContext(old.id, child));
            });
        }
        this._gpuContinuousSourceSnapshots = next;
      })
      .catch(error => {
        console.warn('RZMPS: continuous subsystem source readback failed.', error);
      })
      .finally(() => {
        if (lifecycle === this._gpuLifecycleGeneration) this._gpuContinuousSourcesReadbackPending = false;
      });
  }

  _getParticleInitializationSignature(): string {
    return this.system.modules
      .flatMap(module => module.withDependents())
      .filter(module => module.initializeParticleGPU !== undefined)
      .map(
        module =>
          `${this._getObjectSignature(module)}:${module.version}:${module.tags?.join(',') ?? ''}:` +
          this._getObjectSignature(module.initializeParticleGPU!),
      )
      .join('|');
  }
  clear(gpuRenderer?: WebGPURenderer): void {
    this._gpuLifecycleGeneration += 1;
    this._isGPUProcessingActive = false;
    this._gpuSkipTimeCompute?.node.dispose();
    this._gpuSkipTimeCompute = undefined;
    this._gpuBuffers?.dispose(gpuRenderer);
    this._gpuRenderOutputBuffers?.dispose(gpuRenderer);
    this._gpuBuffers = undefined;
    this._gpuRenderOutputBuffers = undefined;
    this._gpuSpatialRegistry?.dispose(gpuRenderer);
    this._gpuSpatialRegistry = undefined;
    this._gpuSelectiveReadbacks.forEach(slot => slot.state.dispose(gpuRenderer));
    this._gpuSelectiveReadbacks.length = 0;
    this._gpuSelectiveReadbackOverflowCount = 0;
    this._gpuSelectiveReadbackBytes = 0;
    this._gpuSelectiveReadbackLatencyMs = 0;
    this._gpuAllocationBuffer = undefined;
    this._gpuAllocationDiagnostics = undefined;
    this._gpuAllocationReadbackPending = false;
    this._lastGPUAllocationReadbackTime = Number.NEGATIVE_INFINITY;
    this._gpuStandaloneEmitterInstances = undefined;
    this._gpuContinuousEmitterInstances = undefined;
    this._gpuEventEmitterInstances = undefined;
    this._gpuEmissionRuns = undefined;
    this._gpuSubSystemFrameInput = undefined;
    this._gpuContinuousSourcesReadbackPending = false;
    this._gpuContinuousSourceSnapshots = [];
    this._stagedBirthBuffers?.dispose(gpuRenderer);
    this._stagedBirthBuffers = undefined;
    this._stagedBirthCompute?.nodes.forEach(node => node.dispose());
    this._stagedBirthCompute = undefined;
    this._gpuParticleSlotIds.length = 0;
    this._gpuParticleSlotGenerations.length = 0;
    this._gpuParticleSlotIdentities.clear();
    this._disposeGPUComputeCaches();
    this._gpuReadbackPending = false;
    this._gpuReadbacksInFlight = 0;
    this._gpuReadbackSequence = 0;
    this._latestAppliedGPUReadbackSequence = 0;
    this._lastGPUReadbackRequestTime = Number.NEGATIVE_INFINITY;
    this._gpuCPUMirrorStale = false;
    this._gpuDirtyParticleSlots.clear();
  }
  skipTime(renderer: WebGPURenderer, buffers: GPUParticleBufferState): void {
    this._gpuSkippedTimeNode.value = this.execution.skippedTime();
    if (
      !this._gpuSkipTimeCompute ||
      this._gpuSkipTimeCompute.buffers !== buffers ||
      this._gpuSkipTimeCompute.version !== buffers.version ||
      this._gpuSkipTimeCompute.count !== buffers.count
    ) {
      this._gpuSkipTimeCompute?.node.dispose();
      const node = Fn(() => {
        const particle = buffers.storage.createParticle(undefined, true);
        If(particle.alive.notEqual(uint(0)), () => {
          particle.realtime.addAssign(this._gpuSkippedTimeNode.mul(1000));
          particle.time.assign(particle.realtime.div(1000).div(particle.lifetime));
          buffers.storage.storeParticle(particle);
        });
      })().compute(buffers.count);
      this._gpuSkipTimeCompute = { buffers, version: buffers.version, count: buffers.count, node };
    }
    renderer.compute(this._gpuSkipTimeCompute.node);
  }
  private _eventReadbackExecution() {
    return {
      required: () => this._needsCPUEventReadback(),
      lifecycle: () => this._gpuLifecycleGeneration,
      identity: (slot: number, generation: number) => this._getGPUParticleIdentity(slot, generation),
      tags: (mask: number) => this._getGPUTagsFromMask(mask),
      debug: (message: string, data: unknown) => this._logGPUDebug(message, data),
      deliver: (event: GPUEventReadbackBatch['events'][number]) => {
        if (event.type === GPUEventType.Death) {
          this._dispatchGPUDeathEvent(event.slot, event.generation, event.particle);
        } else if (event.type === GPUEventType.Spawn) {
          this.execution.spawnEvent(event.particle);
        } else if (event.type === GPUEventType.Collision) {
          if (event.collision) this.execution.collisionEvent(event.particle, event.collision);
        } else {
          const name = Array.from(this.system.eventRuntime._eventTypes).find(([, id]) => id === event.type)?.[0];
          if (name) this.execution.dispatchSourceEvent(event.particle, name, event.data, true);
        }
      },
    };
  }
}
