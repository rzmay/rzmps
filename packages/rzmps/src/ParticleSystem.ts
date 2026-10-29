import * as THREE from 'three';
import EmissionSource, { type EmissionSourceData, type SubSystemSource } from './EmissionSource';
import { eventNames, cpuEventHandler, type EventSubscriptions, type GPUEmissionContext } from './Events';
import tagsIntersect from './helpers/tagsIntersect';
import Particle, { type ParticleCachedValues } from './Particle';
import Emitter, { rotateEulerYXZGPU, rotateFromYGPU, type EmissionContext } from './Emitter';
import type { GPUEmissionSupportReport } from './gpu/Emission';
import Module from './Module';
import Renderer from './Renderer';
import ParticleOctree from './helpers/ParticleOctree';
import acceptMultiple from './helpers/acceptMultiple';
import SpriteRenderer from './renderers/SpriteRenderer';
import type { Multiple } from './types/Multiple';
import type { DynamicValue } from './types/DynamicValue';
import evaluateDynamicNumber from './helpers/evaluateDynamicNumber';
import particleRatio from './helpers/particleRatio';
import Collision, { type CollisionListener } from './modules/Collision';
import type { CollisionHit } from './interfaces/ICollisionBackend';
import type { Tag } from './types/Tag';
import { EndBehavior } from './enums/EndBehavior';
import { SimulationSpace } from './enums/SimulationSpace';
import { MaxCulling } from './enums/MaxCulling';
import { WebGPURenderer, type ComputeNode, type Node, StorageBufferAttribute } from 'three/webgpu';
import { float, Fn, hash, If, instanceIndex, Loop, Break, mix, pow, storage, uint, uniform, vec3, vec4, mat4 }
  from 'three/tsl';
import LiveCubemap, { PARTICLE_RENDERER_OBJECT_KEY, type LiveCubemapOptions } from './renderers/LiveCubemap';
import LODHelper, { type LODSettings } from './LODHelper';
import {
  destroyGPUStorageAttribute,
  createGPUParticleBufferState,
  createEmptyGPUParticleBufferState,
  createGPUParticleRenderBufferState,
  type GPUParticleLike,
  type GPUParticleBufferState,
  type GPUParticleRenderBufferState,
  type GPUParticleUpdateContext,
} from './gpu/Particle';
import {
  GPUEventType,
  GPUCollisionEventBufferState,
  GPUEventBufferState,
  type GPUEventReadbackBatch,
} from './gpu/EventBuffer';
import {
  GPUSelectiveReadbackState,
  type GPUParticleReadbackField,
  type GPUSelectiveReadbackRequest,
  type GPUSelectiveReadbackResult,
} from './gpu/SelectiveReadback';
import {
  GPUSpatialEffectRegistry,
  isBatchableEffect,
  type GPUSpatialEffectRecord,
} from './gpu/SpatialEffectRegistry';
import { GPUAllocationBufferState, type GPUAllocationDiagnostics } from './gpu/AllocationBuffer';
import { buildGPUSystemSchedule, type GPUSystemSchedule } from './gpu/SystemScheduler';
import { GPUEmitterInstanceBufferState } from './gpu/EmitterInstanceBuffer';
import { GPUEmissionRunBufferState } from './gpu/Emission';
import { GPUDynamicParameterStore } from './helpers/evaluateDynamicGPU';
import SpatialEffect from './SpatialEffect';
import ParticleSpatialGrid, { type ParticleSpatialGridOptions } from './gpu/ParticleSpatialGrid';
import type { PackedFloatStorage } from './gpu/Storage';

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
  /** Local or world coordinates for simulated particles; changing it converts existing particles. */
  simulationSpace: SimulationSpace | `${SimulationSpace}`;
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

/** Parent-event emission and inheritance; child systems share their parent simulation clock. */
export interface SubSystemOptions {
  /** Predicate or switch selecting whether a parent particle may trigger child emission. */
  shouldEmit: boolean | ((source: SubSystemSource) => boolean);
  /** Select parent source tags, using the same intersection rule as modules/renderers. */
  tags?: Tag[];
  /** Named events, optionally with CPU and TSL context handlers. */
  onEvent?: EventSubscriptions;
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

interface SubSystemEmissionRun {
  id: string;
  transform: THREE.Matrix4;
  startTime: number;
  realtime: number;
  duration?: number;
  particle: {
    position: THREE.Vector3;
    rotation: THREE.Vector3;
    scale: THREE.Vector3;
    color: THREE.Color;
    tags?: Tag[];
    alpha: number;
    lifetime: number;
    mass: number;
    velocity: THREE.Vector3;
  };
  collision?: CollisionHit;
  context?: Partial<EmissionContext>;
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

type GPUUniformNode<T, TNode extends string> = Node<TNode> & {
  value: T;
};

interface GPUComputeCache {
  key: string;
  node: ComputeNode;
}

interface GPUComputeListCache {
  key: string;
  nodes: ComputeNode[];
}

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

// Three's matrix node proxy supports column access; its declarations expose it only on arrays.
function matrixColumn(matrix: Node<'mat4'>, index: number): Node<'vec4'> {
  return (matrix as unknown as { element(index: number): Node<'vec4'> }).element(index);
}

function isWebGPURenderer(renderer: unknown): renderer is WebGPURenderer {
  const candidate = renderer as {
    isWebGPURenderer?: boolean;
    backend?: { isWebGLBackend?: boolean };
  } | undefined;

  // Three's WebGPURenderer keeps its identity after falling back to WebGL2,
  // but that backend cannot execute RZMPS's storage-buffer compute pipeline.
  return (renderer instanceof WebGPURenderer || candidate?.isWebGPURenderer === true)
    && candidate?.backend?.isWebGLBackend !== true;
}

function nextPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, value)));
}

/** Owns particle simulation and renderer objects; attach to a Three.js scene and update once per frame. */
class ParticleSystem extends THREE.Object3D {
  static GPU_DYNAMIC_VALUE_RESOLUTION = 16;
  static GPU_INITIAL_BUFFER_SIZE = 256;
  static GPU_READBACK_RATE = 24;
  static GPU_EVENT_BUFFER_CAPACITY = 4096;
  static GPU_SELECTIVE_READBACK_POOL_SIZE = 8;
  static GPU_DEBUG = false;
  static GPU_DEBUG_INTERVAL = 30;

  particles: Particle[] = [];
  emitters: Emitter[] = [];
  modules: Module[] = [];
  spatialEffects: SpatialEffect[] = [];
  renderers: Renderer[] = [];
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
  private _gpuLODCull?: { buffers: GPUParticleBufferState; count: number; version: number; node: ComputeNode };
  private readonly _gpuLODQuality = uniform(1, 'float');

  useLiveCubemap: boolean;
  liveCubemap: LiveCubemap;
  private _gpuProcessing = true;
  /** Canonical GPU storage for renderer preprocessing and managed spatial queries. */
  get gpuParticleBuffers(): GPUParticleBufferState | undefined {
    return this._gpuBuffers;
  }
  /** Whether GPU simulation is requested; activation depends on renderer and components. */
  get gpuProcessing(): boolean { return this._gpuProcessing; }
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
  private _isGPUProcessingActive = false;
  private readonly _particleSpatialGrids = new Map<string, ParticleSpatialGrid>();
  /** System-owned CPU spatial data, created lazily for density compensation. */
  particleOctree?: ParticleOctree<unknown>;
  private _particleSpacing = new Map<string, number>();
  private _particleOctreeToken?: object;
  private _gpuParticleSpacing?: {
    buffers: GPUParticleBufferState; version: number;
    attribute: StorageBufferAttribute; storage: PackedFloatStorage; node: ComputeNode; token?: object;
  };
  private readonly _explicitParticleSpatialGrids = new Set<ParticleSpatialGrid>();
  private _gpuSpatialBuildSequence = 0;
  private _processingMode?: 'cpu' | 'gpu';
  private _gpuProcessingInitialized = false;
  /** Whether the most recent simulation step selected GPU compute. */
  get isGPUProcessingActive(): boolean { return this._isGPUProcessingActive; }
  get liveParticleCount(): number {
    if (this._isGPUProcessingActive && this._gpuAllocationDiagnostics) {
      return this._gpuAllocationDiagnostics.activeCount;
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
    const allocated = this._gpuBuffers?.capacity ?? 0;
    const activeSlots = this._isGPUProcessingActive
      ? (this._gpuAllocationDiagnostics?.activeCount ?? 0)
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
      readbackCount: this._gpuEventReadbackCount,
      buffers: this._gpuEventBuffer ? 1 : 0,
      pending: this._gpuEventReadbacksPending,
      overflowCount: this._gpuEventOverflowCount,
      nextDispatchSequence: this._gpuNextEventDispatchSequence,
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
    const stats = this._gpuSpatialRegistry?.stats;
    return {
      batchableEffects: this._gpuSpatialRegistry?.records.length ?? 0,
      implementationTypes: this._gpuSpatialRegistry?.types.length ?? 0,
      bvhNodes: this._gpuSpatialRegistry?.bvhNodes.length ?? 0,
      parameterVec4s: (this._gpuSpatialRegistry?.parameterAttribute.count ?? 0),
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
      buffers: this._gpuSelectiveReadbacks.length,
      pending: this._gpuSelectiveReadbacks.filter((slot) => slot.pending).length,
      bytes: this._gpuSelectiveReadbackBytes,
      latencyMs: this._gpuSelectiveReadbackLatencyMs,
      overflowCount: this._gpuSelectiveReadbackOverflowCount,
    };
  }

  /** Counts expensive graph/resource builds separately from uniform parameter uploads. */
  get gpuConfigurationStats(): {
    pipelineBuilds: number;
    resourceBuilds: number;
    parameterUploads: number;
  } {
    const modules = this.modules.flatMap((module) => module.withDependents());
    return {
      pipelineBuilds: this._gpuPipelineBuildCount,
      resourceBuilds: this._gpuResourceBuildCount,
      parameterUploads: this._gpuParameters.uploadCount
        + this.emitters.reduce((total, emitter) => total + emitter.gpuParameterUploadCount, 0)
        + modules.reduce((total, module) => total + module.gpuParameterUploadCount, 0)
        + this.renderers.reduce((total, renderer) => total + renderer.gpuParameterUploadCount, 0),
    };
  }

  getGPURendererTagMask(tags: Tag[] | undefined): number | undefined {
    return this._getGPUTagMask(tags);
  }

  /** Acquires a compatible system-owned grid, or registers a caller-owned instance. */
  acquireParticleSpatialGrid(
    gridOrOptions: ParticleSpatialGrid | Partial<ParticleSpatialGridOptions> = {},
  ): ParticleSpatialGrid {
    if (gridOrOptions instanceof ParticleSpatialGrid) {
      this._explicitParticleSpatialGrids.add(gridOrOptions);
      return gridOrOptions;
    }

    const bounds = gridOrOptions.bounds;
    const key = JSON.stringify({
      bounds: bounds ? [bounds.min.toArray(), bounds.max.toArray()] : undefined,
      brickSubdivisions: gridOrOptions.brickSubdivisions ?? 3,
      cellSubdivisions: gridOrOptions.cellSubdivisions ?? 4,
      powerOfTwoBounds: gridOrOptions.powerOfTwoBounds ?? true,
      autoExpand: gridOrOptions.autoExpand ?? true,
      expansionHysteresis: gridOrOptions.expansionHysteresis ?? 0.125,
      timeQuality: gridOrOptions.timeQuality ?? 1,
      maxQuerySteps: gridOrOptions.maxQuerySteps ?? 0,
    });
    let grid = this._particleSpatialGrids.get(key);
    if (!grid) {
      grid = new ParticleSpatialGrid(gridOrOptions);
      this._particleSpatialGrids.set(key, grid);
    }
    return grid;
  }

  /** Stable per-root local spacing shared by all CPU renderer views. */
  getParticleSpacing(particle: Particle, population: Particle[] = this.particles): number {
    const cached = this._particleSpacing.get(particle.id);
    if (cached !== undefined) return cached;
    if (this._particleOctreeToken !== this.renderFrameToken) {
      // Reuse an unfiltered module tree when available. Filtered trees cannot
      // represent the whole system's population.
      const spatialModule = this.modules.find(module => !module.tags?.length && module.getParticleOctree());
      const existing = spatialModule?.getParticleOctree();
      this.particleOctree = existing ?? this.particleOctree ?? new ParticleOctree<number>(
        { maxDepth: 3, particlesPerLeaf: 16 },
        { new: p => p ? 1 : 0, combine: (a, b) => a + b },
      );
      if (!existing) {
        const bounds = new THREE.Box3();
        for (const p of population) if (p.alive) bounds.expandByPoint(p.position);
        if (bounds.isEmpty()) bounds.set(particle.position, particle.position);
        this.particleOctree.setBounds(bounds).rebuild(population);
      }
      const liveIds = new Set(population.filter(p => p.alive).map(p => p.id));
      for (const id of this._particleSpacing.keys()) if (!liveIds.has(id)) this._particleSpacing.delete(id);
      this._particleOctreeToken = this.renderFrameToken;
    }
    const spacing = this.particleOctree!.estimateSpacing(particle);
    this._particleSpacing.set(particle.id, spacing);
    return spacing;
  }

  /** System-owned GPU spacing pass; all native renderers share its output.
   * Values are keyed by simulation slot generation and never read back to CPU.
   */
  getParticleSpacingGPU(): PackedFloatStorage {
    const buffers = this._gpuBuffers!;
    const renderer = this.sceneRenderer as WebGPURenderer;
    let state = this._gpuParticleSpacing;
    if (!state || state.buffers !== buffers || state.version !== buffers.version) {
      if (state) {
        state.node.dispose();
        destroyGPUStorageAttribute(renderer, state.attribute);
      }
      const grid = this.acquireParticleSpatialGrid({ brickSubdivisions: 2, cellSubdivisions: 0, maxQuerySteps: 64 });
      grid.rebuild(renderer, buffers, this.renderFrameToken);
      const attribute = new StorageBufferAttribute(new Float32Array(buffers.capacity * 4), 4);
      const spacing = storage(attribute, 'vec4', buffers.capacity) as PackedFloatStorage;
      const node = Fn(() => {
        const particle = buffers.storage.createParticle();
        const value = spacing.element(instanceIndex);
        If(particle.alive.notEqual(uint(0)).and(value.y.notEqual(float(particle.generation))), () => {
          const fallback = particle.scale.length().mul(0.5).max(0.001);
          value.x.assign(grid.estimateLocalSpacingNode(particle.position, instanceIndex, fallback));
          value.y.assign(float(particle.generation));
        });
      })().compute(buffers.capacity).setName('rzmps.spacing');
      state = { buffers, version: buffers.version, attribute, storage: spacing, node };
      this._gpuParticleSpacing = state;
    }
    if (state.token !== this.renderFrameToken) {
      const grid = this.acquireParticleSpatialGrid({ brickSubdivisions: 2, cellSubdivisions: 0, maxQuerySteps: 64 });
      grid.rebuild(renderer, buffers, this.renderFrameToken);
      renderer.compute(state.node);
      state.token = this.renderFrameToken;
    }
    return state.storage;
  }

  get gpuAllocationStats(): GPUAllocationDiagnostics | undefined {
    return this._gpuAllocationDiagnostics ?? this._gpuAllocationBuffer?.snapshot();
  }

  /** Audits built-in/custom emitter and subsystem eligibility for GPU-native emission. */
  getGPUEmissionSupport(): ParticleSystemGPUEmissionSupportReport {
    const emitters = this.emitters.map((emitter) => emitter.getGPUEmissionSupport());
    const reasons = emitters.flatMap((report, index) => (
      report.supported ? [] : report.reasons.map((reason) => `Emitter ${index}: ${reason}`)
    ));
    const subsystems: ParticleSystemGPUEmissionSupportReport['subsystems'] = [];

    this.subSystems.forEach((options, subSystem) => {
      const subReasons: string[] = [];
      if (typeof options.shouldEmit === 'function') {
        subReasons.push('Subsystem shouldEmit function requires an explicit GPU predicate.');
      }
      if (
        options.emitOnCollision
        && !this.modules.some((module) => module instanceof Collision && module.supportsGPU)
      ) {
        subReasons.push('Collision-triggered GPU emission requires a GPU collision event producer.');
      }
      const childReport = subSystem.getGPUEmissionSupport();
      subReasons.push(...childReport.reasons.map((reason) => `Child: ${reason}`));

      subsystems.push({
        system: subSystem,
        supported: subReasons.length === 0,
        reasons: subReasons,
      });
    });

    reasons.push(...subsystems.flatMap((report, index) => (
      report.supported ? [] : report.reasons.map((reason) => `Subsystem ${index}: ${reason}`)
    )));

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

  private _simulationSpace: SimulationSpace = SimulationSpace.Local;
  /** Coordinate space of particle state; assigning a new space converts particles and propagates to subsystems. */
  get simulationSpace(): SimulationSpace {
    return this._simulationSpace;
  }
  set simulationSpace(value: SimulationSpace) {
    if (value === this._simulationSpace) return;

    this.convertParticlesToSimulationSpace(value);
    this._simulationSpace = value;
    this.subSystems.forEach((_options, subSystem) => {
      subSystem.simulationSpace = value;
    });
    this.syncRendererParents();
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
  get sceneCamera() { return this._camera; }
  private readonly _sceneCameraQuaternion = new THREE.Quaternion();
  /** Cached world orientation of the last active render camera. */
  get sceneCameraQuaternion() { return this._sceneCameraQuaternion; }

  private _renderer?: THREE.WebGLRenderer | WebGPURenderer;
  /** Active renderer captured by the context object during rendering. */
  get sceneRenderer() { return this._renderer; }
  private _cameraDistanceSq = Number.MAX_SAFE_INTEGER;
  /** Squared camera distance used for component LOD; explicit advancement refreshes it without skipping steps. */
  get cameraDistanceSq(): number { return this._cameraDistanceSq; }

  private deltaTime = 0;
  private lastFrame: number;

  private _subSystemParent?: ParticleSystem;
  /** Whether a parent owns simulation and emission contexts for this system. */
  get isSubSystem(): boolean { return !!this._subSystemParent; }

  private _deathListeners: ParticleListener[] = [];
  private _spawnListeners: ParticleListener[] = [];
  private _collisionListeners: CollisionListener[] = [];

  private readonly _emissionSources = new Map<string, EmissionSource>();
  private readonly _stagedBirths: Particle[] = [];
  private readonly _pendingGPUEvents: Array<{ slot: number; generation: number; event: string; data?: unknown }> = [];
  private _stagedBirthBuffers?: GPUParticleBufferState;
  private _stagedBirthCompute?: GPUComputeListCache;
  private readonly _stagedBirthCount = uniform(0, 'uint');
  private readonly _eventTypes = new Map<string, number>([['death', 1], ['spawn', 2], ['collision', 3]]);

  private _emissionRuns: SubSystemEmissionRun[] = [];
  private _nextEmissionRunId = 0;

  private _playing = true;
  /** Whether the system is emitting; pause is a separate flag. */
  get playing(): boolean { return this._playing; }

  private _paused = false;
  /** Whether simulation is frozen by pause(). */
  get paused(): boolean { return this._paused; }

  private _ended = false;
  /** Whether a nonlooping duration has ended or stop() was called. */
  get ended(): boolean { return this._ended; }

  private _elapsedTime = 0;
  private _prewarmed = false;
  private _isPrewarming = false;
  private _lodHelper: LODHelper;

  private _destroyed = false;
  /** Whether permanent destruction has completed. */
  get destroyed(): boolean { return this._destroyed; }

  private readonly _rendererObjects = new Set<THREE.Object3D>();
  private readonly _worldRendererRoot = new THREE.Group();
  private _contextCaptureDummy: THREE.Mesh;
  private readonly _simulationDistanceWorldPos = new THREE.Vector3();
  private readonly _simulationDistanceCameraWorldPos = new THREE.Vector3();
  private readonly _emitterContextWorldPosition = new THREE.Vector3();
  private readonly _emitterContextPreviousWorldPosition = new THREE.Vector3();
  private readonly _emitterContextVelocity = new THREE.Vector3();
  private _hasEmitterContextPreviousWorldPosition = false;
  private readonly _particleEmissionQuaternion = new THREE.Quaternion();
  private readonly _particleEmissionEuler = new THREE.Euler();
  private readonly _particleEmissionUnitY = new THREE.Vector3(0, 1, 0);
  private readonly _particleEmissionAlignUp = new THREE.Vector3();
  private readonly _particleEmissionUnitScale = new THREE.Vector3(1, 1, 1);
  private readonly _particleEmissionScale = new THREE.Vector3(1, 1, 1);
  private readonly _particleEmissionColor = new THREE.Color(1, 1, 1);
  private readonly _particleEmissionVelocity = new THREE.Vector3();
  private readonly _particleBoundsMin = new THREE.Vector3();
  private readonly _particleBoundsMax = new THREE.Vector3();
  private readonly _particleBoundsSize = new THREE.Vector3(1, 1, 1);
  private readonly _spatialEffectTravelBounds = new THREE.Box3();
  private readonly _spatialEffectBoundsInverse = new THREE.Matrix4();
  private readonly _directionNormalMatrix = new THREE.Matrix3();
  private readonly _inverseWorldMatrix = new THREE.Matrix4();
  private _gpuBuffers?: GPUParticleBufferState;
  private _gpuRenderOutputBuffers?: GPUParticleRenderBufferState;
  private _gpuSpatialRegistry?: GPUSpatialEffectRegistry;
  private readonly _gpuSelectiveReadbacks: GPUSelectiveReadbackSlot[] = [];
  private _gpuSelectiveReadbackOverflowCount = 0;
  private _gpuSelectiveReadbackBytes = 0;
  private _gpuSelectiveReadbackLatencyMs = 0;
  private _gpuAllocationBuffer?: GPUAllocationBufferState;
  private _gpuAllocationDiagnostics?: GPUAllocationDiagnostics;
  private _gpuAllocationReadbackPending = false;
  private _lastGPUAllocationReadbackTime = Number.NEGATIVE_INFINITY;
  private _gpuStandaloneEmitterInstances?: GPUEmitterInstanceBufferState;
  private _gpuContinuousEmitterInstances?: GPUEmitterInstanceBufferState;
  private _gpuEventEmitterInstances?: GPUEmitterInstanceBufferState;
  private _gpuEmissionRuns?: GPUEmissionRunBufferState;
  private _gpuSubSystemFrameInput?: GPUSubSystemFrameInput;
  private _cpuSubSystemFrameActive = false;
  private _gpuContinuousSourcesReadbackPending = false;
  private _gpuContinuousSourceSnapshots: Particle[] = [];
  private _gpuFrameEventBuffer?: GPUEventBufferState;
  private _gpuEventBuffer?: GPUEventBufferState;
  private _gpuCollisionEventBuffer?: GPUCollisionEventBufferState;
  private _gpuEventReadbacksPending = 0;
  private _gpuEventReadbackCount = 0;
  private _gpuEventFrameSequence = 0;
  private _gpuNextEventDispatchSequence = 1;
  private readonly _gpuCompletedEventBatches = new Map<number, GPUEventReadbackBatch>();
  private readonly _gpuDeliveredDeathEvents = new Set<string>();
  private readonly _gpuParticleSlotIds: Array<string | undefined> = [];
  private readonly _gpuParticleSlotGenerations: number[] = [];
  private readonly _gpuParticleSlotIdentities = new Map<string, GPUSlotIdentity>();
  private _gpuEventOverflowCount = 0;
  private readonly _gpuTagRegistry = new Map<Tag, number>();
  private _gpuTagOverflow = false;
  private _gpuReadbackPending = false;
  private _gpuLifecycleGeneration = 0;
  private _gpuReadbacksInFlight = 0;
  private _gpuReadbackSequence = 0;
  private _latestAppliedGPUReadbackSequence = 0;
  private _lastGPUReadbackRequestTime = Number.NEGATIVE_INFINITY;
  private _gpuCPUMirrorStale = false;
  private readonly _gpuDirtyParticleSlots = new Set<number>();
  private _gpuDebugFrame = 0;
  private _gpuDebugActiveFrame: number | undefined;
  private _gpuPipelineBuildCount = 0;
  private _gpuResourceBuildCount = 0;
  private readonly _gpuDeltaTimeNode = uniform(0, 'float')
    .setName('rzmpsDeltaTime') as unknown as GPUUniformNode<number, 'float'>;
  private readonly _gpuElapsedTimeNode = uniform(0, 'float')
    .setName('rzmpsElapsedTime') as unknown as GPUUniformNode<number, 'float'>;
  private readonly _gpuDurationNode = uniform(1, 'float')
    .setName('rzmpsDuration') as unknown as GPUUniformNode<number, 'float'>;
  private readonly _gpuGravityNode = uniform(new THREE.Vector3(), 'vec3')
    .setName('rzmpsGravity') as unknown as GPUUniformNode<THREE.Vector3, 'vec3'>;
  private readonly _gpuEmitterPositionNode = uniform(new THREE.Vector3(), 'vec3')
    .setName('rzmpsEmitterPosition') as unknown as GPUUniformNode<THREE.Vector3, 'vec3'>;
  private readonly _gpuSimulationToWorldNode = uniform(new THREE.Matrix4(), 'mat4')
    .setName('rzmpsSimulationToWorld') as unknown as GPUUniformNode<THREE.Matrix4, 'mat4'>;
  private readonly _gpuWorldToSimulationNode = uniform(new THREE.Matrix4(), 'mat4')
    .setName('rzmpsWorldToSimulation') as unknown as GPUUniformNode<THREE.Matrix4, 'mat4'>;
  private readonly _gpuEventFrameNode = uniform(0, 'uint')
    .setName('rzmpsEventFrame') as unknown as GPUUniformNode<number, 'uint'>;
  private _gpuEmissionComputeCache?: GPUComputeListCache;
  private _gpuOldEmissionComputeCache?: GPUComputeListCache;
  private _gpuOldSelectionComputeCache?: GPUComputeListCache;
  private _gpuOldDeathEventComputeCache?: GPUComputeCache;
  private _gpuAllocationSnapshotComputeCache?: GPUComputeCache;
  private _gpuSpawnEventComputeCache?: GPUComputeCache;
  private _gpuEmissionPrepareComputeCache?: GPUComputeListCache;
  private _gpuEmissionFinalizeComputeCache?: GPUComputeListCache;
  private _gpuContinuousSubSystemComputeCache?: GPUComputeListCache;
  private _gpuEventSubSystemComputeCache?: GPUComputeListCache;
  private _gpuSimulationComputeCache?: GPUComputeCache;
  private readonly _gpuSimulationComputeCaches = new Map<string, GPUComputeCache>();
  private readonly _gpuModifierComputeCaches = new Map<string, GPUComputeCache>();
  private _gpuRenderOutputComputeCache?: GPUComputeCache;
  private readonly _gpuObjectIds = new WeakMap<object, number>();
  private _nextGPUModifierId = 1;
  private readonly _gpuParameters = new GPUDynamicParameterStore();

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
    this.gpuDebugInterval = Math.max(1, options.gpuDebugInterval ?? ParticleSystem.GPU_DEBUG_INTERVAL);
    this.duration = options.duration ?? 10;
    this.prewarm = options.prewarm ?? false;
    this.prewarmFPS = options.prewarmFPS ?? 24;
    this.looping = options.looping ?? true;
    this.endBehavior = (options.endBehavior as EndBehavior) ?? EndBehavior.None;

    this.maxParticles = Math.max(options.maxParticles ?? this.maxParticles, 0);
    this.maxCullingMode = (options.maxCullingMode as MaxCulling) ?? MaxCulling.New;
    this.simulationDistance = Math.max(options.simulationDistance ?? 0, 0);
    this.lod = options.lod;
    this._lodHelper = new LODHelper(this.lod);

    // Init live cubemap, even if unused
    this.useLiveCubemap = options.useLiveCubemap
      ?? Boolean(options.cubemapSettings || options.liveCubemapFPS || options.liveCubemapResolutionScale);
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
    this._simulationSpace = (options.simulationSpace as SimulationSpace) ?? this._simulationSpace;
    this._worldRendererRoot.name = 'ParticleSystem World Renderers';

    this.lastFrame = Date.now();

    this.emitters.forEach((e) => e.setup(this));
    this.renderers.forEach((r) => r.setup(this));

    // Store these here so that other renderers/modules can access easily.
    // The dummy renders no color, but avoids frustum culling so offscreen roots
    // can still capture the active renderer, scene, and camera.
    this._contextCaptureDummy = new THREE.Mesh();
    this._contextCaptureDummy.frustumCulled = false;
    this.add(this._contextCaptureDummy );

    this._contextCaptureDummy .onBeforeRender = (renderer, scene, camera) => {
      if (LiveCubemap.isLiveCubemapCamera(camera)) return;

      this._renderer = renderer;
      this._scene = scene;
      this._camera = camera;
      camera.getWorldQuaternion(this._sceneCameraQuaternion);
    }

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

    this._advanceSimulationStep(false);

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
        this._advanceSimulationStep();
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
    this._gpuLODQuality.value = this.quality;
  }

  private _advanceSimulationStep(handleEndBehavior: boolean = true): void {
    this._updateLODQuality();
    if (this._playing) this._updateSystemTime();
    if (this._playing && !this._shouldExecuteEmittersOnGPU()) this.emitters.forEach((emitter) => {
      const particles = emitter.update(this.particles, this.getEmitterContext(), this);
      particles.forEach((particle) => this._notifySpawn(particle));
    });
    this._processParticles();
    this._updateSubSystems();
    if (handleEndBehavior) this._handleEndBehavior();
  }

  private _scaleDeltaTime(deltaTime: number): number {
    const speed = Number.isFinite(this.simulationSpeed)
      ? Math.max(0, this.simulationSpeed)
      : 1;

    return deltaTime * speed;
  }

  private _processParticles() {
    this._renderFrameToken = {};
    this._updateLODQuality();
    // LOD destruction is deliberately separate from lifecycle death notification.
    if (!this._isGPUProcessingActive && this.quality < 1) {
      this.particles = this.particles.filter((particle) => {
        if (particle.lodPriority < this.quality) return true;
        particle.alive = false;
        this.subSystems.forEach((_options, subSystem) => {
          subSystem.emitters.forEach(emitter => emitter.clearContext(particle.id));
        });
        return false;
      });
    }
    // Cull particles
    if (this.particles.length > this.maxParticles) {
      if (this._usesGPUStableParticleSlots()) {
        this.particles
          .slice(this.maxParticles)
          .forEach((particle) => {
            if (!particle.alive) return;
            particle.alive = false;
            this._notifyParticleDeath(particle);
          });
        this.particles.length = this.maxParticles;
      } else if (this.maxCullingMode == MaxCulling.New) this.particles.splice(this.maxParticles)
      else this.particles.splice(0, this.particles.length - this.maxParticles)
    }

    this.particles.forEach((particle) => particle.restore());
    this.updateBoundingBox();

    // Module preparation
    const modules = this.modules
      .flatMap((module) => module.withDependents());
    const spatialEffects = this._getSpatialEffects();

    this.emitters.forEach((emitter) => emitter.syncGPUConfiguration());
    modules.forEach((module) => module.syncGPUConfiguration());
    this.renderers.forEach((renderer) => renderer.syncGPUConfiguration());
    this._gpuParameters.sync();

    this._discoverEventTypes();
    this._prepareGPUTagRegistry(modules, spatialEffects);

    const processingMode = this._canProcessParticlesOnGPU(modules, spatialEffects)
      ? 'gpu'
      : 'cpu';
    if (this._processingMode && this._processingMode !== processingMode) {
      this.reset(false);
    }
    this._processingMode = processingMode;

    if (processingMode === 'gpu') {
      this._processParticlesGPU(modules, spatialEffects);
      return;
    }

    this._isGPUProcessingActive = false;

    modules
      .forEach((module) => module.prepare(this, this.deltaTime));

    const modifiers = [...modules, ...spatialEffects];

    const permanentPreMovementModifiers = modifiers
      .filter((modifier) => modifier.priority < 0)
      .sort((a, b) => a.priority - b.priority)
    const transientPreMovementModifiers = modifiers
      .filter((modifier) => modifier.priority >= 0 && modifier.priority < 1)
      .sort((a, b) => a.priority - b.priority)
    const transientRenderModifiers = modifiers
      .filter((modifier) => modifier.priority >= 1)
      .sort((a, b) => a.priority - b.priority);

    // Run permanent pre-movement modules
    permanentPreMovementModifiers
      .forEach((modifier) => modifier.modify(this.particles, this.deltaTime, this));

    const transientBaseValues = transientPreMovementModifiers.length > 0
      ? this.particles.map((particle) => particle.snapshot())
      : undefined;

    // Run transient pre-movement modules
    transientPreMovementModifiers
      .forEach((modifier) => modifier.modify(this.particles, this.deltaTime, this));

    // Update particles, caching permanent state before render-time transients.
    this._updateParticles(transientBaseValues);

    if (!transientBaseValues) {
      this.particles.forEach((particle) => particle.cache());
    }

    // Prewarming advances authoritative simulation state only. Rendering these
    // intermediate CPU frames mutates instance matrices immediately before a
    // GPU restart and has no effect on the resulting simulation.
    if (!this._isPrewarming) {
      transientRenderModifiers
        .forEach((modifier) => modifier.modify(this.particles, this.deltaTime, this));

      this.renderers.forEach((renderer) => {
        renderer.update(this.particles, this, this.deltaTime);
      });
    }
  }

  private _canProcessParticlesOnGPU(modules: Module[], spatialEffects: SpatialEffect[]): boolean {
    const gpuSpatialEffects = spatialEffects.filter((spatialEffect) => spatialEffect.supportsGPU);
    const hasCPUInputRenderer = this.renderers.some((renderer) => !renderer.supportsGPUInput);
    const hasRenderTimeModifier = [...modules, ...gpuSpatialEffects]
      .some((modifier) => modifier.priority >= 1);

    return this.gpuProcessing
      && isWebGPURenderer(this.sceneRenderer)
      && !this._gpuTagOverflow
      && !(hasCPUInputRenderer && hasRenderTimeModifier)
      && modules.every((module) => module.supportsGPU);
  }

  private _shouldExecuteEmittersOnGPU(): boolean {
    if (this._cpuSubSystemFrameActive) return false;

    const modules = this.modules.flatMap((module) => module.withDependents());
    const spatialEffects = this._getSpatialEffects();
    this._discoverEventTypes();
    this._prepareGPUTagRegistry(modules, spatialEffects);

    return this._canProcessParticlesOnGPU(modules, spatialEffects)
      && this.emitters.length > 0;
  }

  private _processParticlesGPU(modules: Module[], spatialEffects: SpatialEffect[]): void {
    const sceneRenderer = this.sceneRenderer;
    if (!isWebGPURenderer(sceneRenderer)) return;
    this._flushTargetedGPUEvents();
    const lifecycleGeneration = this._gpuLifecycleGeneration;
    const gpuSpatialEffects = spatialEffects.filter((spatialEffect) => spatialEffect.supportsGPU);

    const debugFrame = this._beginGPUDebugFrame(modules);
    const hasPendingReadback = this._gpuReadbackPending;
    const preserveGPUState = hasPendingReadback || this._gpuCPUMirrorStale;

    if (preserveGPUState) {
      this._logGPUDebug('CPU mirror stale; preserving GPU state', {
        inFlight: this._gpuReadbacksInFlight,
        particleCount: this.particles.length,
        gpuCount: this._gpuBuffers?.count,
        sample: this._sampleGPUParticles(this.particles),
      });
    } else {
      this._logGPUDebug('before restore', {
        particleCount: this.particles.length,
        sample: this._sampleGPUParticles(this.particles),
      });
      this.particles.forEach((particle) => {
        if (particle.alive) particle.restore();
      });
      this._markExpiredGPUParticleSlots();
      this._logGPUDebug('after restore + death sync', {
        particleCount: this.particles.length,
        sample: this._sampleGPUParticles(this.particles),
      });
    }

    this._isGPUProcessingActive = true;

    modules
      .forEach((module) => module.prepare(this, this.deltaTime));

    this._logGPUDebug('prepared modules', {
      modifiers: this._describeGPUModules(modules),
    });

    const gpuNativeEmission = this._shouldExecuteEmittersOnGPU();

    if (!this._gpuBuffers) {
      this._gpuResourceBuildCount += 1;
      this._gpuBuffers = createGPUParticleBufferState(
        this.particles,
        this._getInitialGPUBufferCapacity(),
        (particle) => this._getParticleGPUTagMask(particle),
        (particle, index) => this._getGPUParticleSlotGeneration(particle, index),
      );
    } else if (preserveGPUState) {
      this._uploadDirtyGPUParticleSlots(this._gpuBuffers);
    } else {
      this._gpuBuffers.upload(
        this.particles,
        (particle) => this._getParticleGPUTagMask(particle),
        (particle, index) => this._getGPUParticleSlotGeneration(particle, index),
      );
    }
    if (gpuNativeEmission) {
      const estimatedCapacity = this._getInitialGPUBufferCapacity();
      if (
        estimatedCapacity > this._gpuBuffers.capacity
        && this._gpuBuffers.grow(sceneRenderer, estimatedCapacity)
      ) {
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
      sample: this._sampleGPUParticles(this.particles),
    });

    const lodBuffers = this._gpuBuffers;
    if (
      !this._gpuLODCull
      || this._gpuLODCull.buffers !== lodBuffers
      || this._gpuLODCull.version !== lodBuffers.version
      || this._gpuLODCull.count !== lodBuffers.count
    ) {
      this._gpuLODCull?.node.dispose();
      const node = Fn(() => {
        const state = lodBuffers.storage.createStateNode();
        If(float(state.w).div(4294967296).greaterThanEqual(this._gpuLODQuality), () => { state.x.assign(uint(0)); });
      })().compute(lodBuffers.count).setName('rzmps.lod.cull');
      this._gpuLODCull = { buffers: lodBuffers, count: lodBuffers.count, version: lodBuffers.version, node };
    }
    if (this.quality < 1) sceneRenderer.compute(this._gpuLODCull.node);

    this._gpuDirtyParticleSlots.clear();
    this._updateGPURuntimeUniforms();
    const allocationBuffer = this._acquireGPUAllocationBuffer(sceneRenderer);
    allocationBuffer.reset(
      this._gpuEventFrameSequence + 1,
      this.particles.reduce((count, particle) => count + (particle.alive ? 1 : 0), 0),
      this._getGPUCullingModeCode(),
    );
    const eventBuffer = this._hasGPUEventConsumers()
      ? this._acquireGPUEventBuffer(sceneRenderer)
      : undefined;
    const eventWriter = eventBuffer?.createWriter();
    const collisionEventWriter = eventWriter
      ? this._acquireGPUCollisionEventBuffer(sceneRenderer).createWriter(this._gpuEventFrameNode)
      : undefined;

    if (eventBuffer) {
      const eventSequence = this._gpuEventFrameSequence + 1;
      this._gpuEventFrameSequence = eventSequence;
      this._gpuEventFrameNode.value = eventSequence;
      eventBuffer.reset(eventSequence);
      eventBuffer.initialize(sceneRenderer);
    }
    this._gpuFrameEventBuffer = eventBuffer;

    const tagMaskForEffect = (effect: SpatialEffect) => this._getGPUTagMask(effect.tags) ?? 0;
    gpuSpatialEffects.forEach((effect) => effect.syncGPUTransform(this));
    if (!this._gpuSpatialRegistry?.update(gpuSpatialEffects, this, tagMaskForEffect)) {
      this._gpuSpatialRegistry?.dispose(sceneRenderer);
      this._gpuResourceBuildCount += 1;
      this._gpuSpatialRegistry = GPUSpatialEffectRegistry.build(
        gpuSpatialEffects,
        this,
        tagMaskForEffect,
      );
    }

    const context: GPUParticleUpdateContext = {
      system: this,
      buffers: this._gpuBuffers,
      deltaTime: this.deltaTime,
      deltaTimeNode: this._gpuDeltaTimeNode,
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

    if (gpuNativeEmission || this._gpuSubSystemFrameInput) {
      this._computeGPUAllocationSnapshot(context);
    }

    if (this._gpuSubSystemFrameInput) {
      if (this._gpuSubSystemFrameInput.options.emitContinuous) {
        this._computeGPUContinuousSubSystemEmissionPhase(context, this._gpuSubSystemFrameInput);
      }
      if (
        this._gpuSubSystemFrameInput.options.emitOnDeath
        || this._gpuSubSystemFrameInput.options.emitOnSpawn
        || this._gpuSubSystemFrameInput.options.emitOnCollision
        || eventNames(this._gpuSubSystemFrameInput.options.onEvent).length > 0
      ) {
        this._computeGPUEventSubSystemEmissionPhase(context, this._gpuSubSystemFrameInput);
      }
    } else {
      this._computeGPUEmissionPhase(context);
    }
    this._computeStagedBirths(context);
    this._computeGPUSpawnEventPhase(context);

    const permanentPreMovementModifiers = modifiers
      .filter((module) => module.priority < 0)
      .sort((a, b) => a.priority - b.priority);

    const transientPreMovementModifiers = modifiers
      .filter((module) => module.priority >= 0 && module.priority < 1)
      .sort((a, b) => a.priority - b.priority);

    const transientRenderModifiers = modifiers
      .filter((module) => module.priority >= 1)
      .sort((a, b) => a.priority - b.priority);

    this._gpuSpatialRegistry?.configureSegments([
      permanentPreMovementModifiers,
      transientPreMovementModifiers,
      transientRenderModifiers,
    ]);

    const fusedPermanentModifiers = this._computeGPUCollisionAndModifierPhases(
      context,
      permanentPreMovementModifiers,
    );

    this._logGPUDebug('phase: fused simulation', {
      permanent: this._describeGPUModifiers(fusedPermanentModifiers),
      transientPreMovement: this._describeGPUModifiers(transientPreMovementModifiers),
    });
    this._computeGPUSimulationPhase(
      context,
      fusedPermanentModifiers,
      transientPreMovementModifiers,
    );
    this._scheduleGPUAllocationReadback(allocationBuffer, sceneRenderer);
    if (eventBuffer && !this._hasGPUNativeSubSystemConsumers()) {
      this._scheduleGPUEventReadback(eventBuffer, sceneRenderer);
    }

    const shouldRequestReadback = !gpuNativeEmission
      && !hasPendingReadback
      && this._shouldRequestGPUReadback();
    const readbackSequence = shouldRequestReadback ? this._gpuReadbackSequence + 1 : 0;
    const readbackParticles = shouldRequestReadback
      ? this.particles.slice(0, this._gpuBuffers.count)
      : [];
    const readbackWasAlive = shouldRequestReadback
      ? readbackParticles.map((particle) => particle.alive)
      : [];
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
        readbackRate: ParticleSystem.GPU_READBACK_RATE,
        sample: this._sampleGPUParticles(readbackParticles),
      });
      cpuMirrorUpdate = this._gpuBuffers.readback(sceneRenderer, readbackParticles);
    } else {
      this._gpuCPUMirrorStale = true;
      this._logGPUDebug('readback skipped', {
        reason: hasPendingReadback ? 'pending' : 'rate limit',
        readbackRate: ParticleSystem.GPU_READBACK_RATE,
        particleCount: this.particles.length,
        gpuCount: this._gpuBuffers.count,
      });
    }

    const cpuInputRenderers = this.renderers.filter((renderer) => !renderer.supportsGPUInput);
    const gpuInputRenderers = this.renderers.filter((renderer) => renderer.supportsGPUInput);
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

      this._computeGPURenderOutputPhase(
        this._gpuBuffers,
        this._gpuRenderOutputBuffers,
        renderModifiers,
        context,
      );
    } else {
      this._logGPUDebug('phase: render-time transient skipped on GPU', {
        reason: needsRenderModifiers ? 'no GPU-input renderers' : 'no render-time modifiers',
        modifiers: this._describeGPUModifiers(renderModifiers),
      });
    }

    const gpuRenderBuffers = needsCompactRenderBuffer ? this._gpuRenderOutputBuffers : this._gpuBuffers;

    this._logGPUDebug('renderer handoff', {
      gpuRenderers: gpuInputRenderers.map((renderer) => renderer.constructor.name),
      cpuRenderers: cpuInputRenderers.map((renderer) => renderer.constructor.name),
      gpuRenderBuffer: needsCompactRenderBuffer ? 'compact render output buffer' : 'main buffer',
      cpuRenderBuffer: 'main buffer',
    });

    gpuInputRenderers.forEach((renderer) => {
      renderer.updateGPU(gpuRenderBuffers!, this, this.deltaTime);
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

          cpuInputRenderers.forEach((renderer) => {
            renderer.update(renderParticles, this, this.deltaTime);
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
          sample: this._sampleGPUParticles(this.particles),
        });

        const renderParticles = this.particles.filter(particle => particle.alive);
        cpuInputRenderers.forEach((renderer) => {
          renderer.update(renderParticles, this, this.deltaTime);
        });

        this._endGPUDebugFrame(debugFrame);
      }
    })();
  }

  private _computeGPUEmissionPhase(context: GPUParticleUpdateContext): void {
    const emitters = this.emitters;
    if (emitters.length <= 0) return;
    const renderer = this.sceneRenderer;
    if (!isWebGPURenderer(renderer)) return;

    const emitterInstances = this._acquireGPUEmitterInstances('standalone', emitters.length, emitters, renderer);
    const prepareNodes = this._getGPUEmissionPrepareComputeNodes(context, emitters, emitterInstances);
    prepareNodes.forEach((node) => renderer.compute(node));
    this._getGPUEmissionComputeNodes(context, emitters, emitterInstances, false)
      .forEach((node) => renderer.compute(node));
    if (this.maxCullingMode === MaxCulling.Old) {
      this._computeGPUOldEmissionPhase(context, emitters, emitterInstances);
    }
    this._getGPUEmissionFinalizeComputeNodes(context, emitters, emitterInstances)
      .forEach((node) => renderer.compute(node));
  }

  private _getGPUEmissionComputeNodes(
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
      `emitters:${emitters.map((emitter) => `${this._getObjectSignature(emitter)}@${emitter.version}`).join(',')}`,
    ].join('|');

    const cached = this._gpuEmissionComputeCache;
    if (cached?.key === cacheKey) {
      return cached.nodes;
    }

    cached?.nodes.forEach((node) => node.dispose?.());

    // Keep each emitter in its own pass so geometry sampling bindings do not
    // accumulate with emitter count and exceed WebGPU's default stage limit.
    const nodes = emitters.map((emitter, emitterIndex) => Fn(() => {
      emitter.createBuiltInGPUUpdate()({
        ...context,
        emitter,
        emitterIndex,
        output: buffers,
        emitterRuntime: emitterInstances.createRuntime(emitterIndex),
        tagMasks: this._getGPUEmitterTagMasks(emitter),
        reclaimOld,
      });
    })().compute(buffers.capacity));

    const entry = {
      key: cacheKey,
      nodes,
    };
    this._gpuPipelineBuildCount += nodes.length;
    this._gpuEmissionComputeCache = entry;

    return nodes;
  }

  private _computeGPUOldEmissionPhase(
    context: GPUParticleUpdateContext,
    emitters: Emitter[],
    emitterInstances: GPUEmitterInstanceBufferState,
  ): void {
    const renderer = this.sceneRenderer;
    if (!isWebGPURenderer(renderer) || !context.allocationWriter) return;

    const selectionKey = [
      'old-emission-selection',
      `buffer:${context.buffers.version}:${context.buffers.capacity}`,
      `instances:${emitterInstances.capacity}`,
      `emitters:${emitters.map((emitter) => `${this._getObjectSignature(emitter)}@${emitter.version}`).join(',')}`,
    ].join('|');
    if (this._gpuOldSelectionComputeCache?.key !== selectionKey) {
      this._gpuPipelineBuildCount += 1;
      this._gpuOldSelectionComputeCache?.nodes.forEach((node) => node.dispose?.());
      this._gpuOldSelectionComputeCache = {
        key: selectionKey,
        nodes: emitters.map((_emitter, emitterIndex) => Fn(() => {
          const particle = context.buffers.storage.createParticle(undefined, true);
          const runtime = emitterInstances.createRuntime(emitterIndex);
          const requested = runtime.requestCount();
          const deadClaims = runtime.claimCount();
          const deadSuccesses = deadClaims.lessThan(requested)
            .select(deadClaims, requested) as Node<'uint'>;
          context.allocationWriter!.selectOldSlotForEmitter(
            particle,
            requested.sub(deadSuccesses),
            () => runtime.claimReplacement(),
          );
        })().compute(context.buffers.capacity)),
      };
    }

    const initializationKey = [
      'old-emission-initialization',
      `buffer:${context.buffers.version}:${context.buffers.capacity}`,
      `instances:${emitterInstances.capacity}`,
      `emitters:${emitters.map((emitter) => `${this._getObjectSignature(emitter)}@${emitter.version}`).join(',')}`,
    ].join('|');
    if (this._gpuOldEmissionComputeCache?.key !== initializationKey) {
      this._gpuPipelineBuildCount += 1;
      this._gpuOldEmissionComputeCache?.nodes.forEach((node) => node.dispose?.());
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

  private _computeGPUOldDeathEventPhase(context: GPUParticleUpdateContext): void {
    const renderer = this.sceneRenderer;
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

  private _computeGPUAllocationSnapshot(context: GPUParticleUpdateContext): void {
    const renderer = this.sceneRenderer;
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

  private _computeGPUSpawnEventPhase(context: GPUParticleUpdateContext): void {
    const renderer = this.sceneRenderer;
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
        If(context.allocationWriter!.wasSpawned(particle), () => {
          context.eventWriter!.emitSpawn(particle);
        });
      })().compute(context.buffers.capacity);
      this._gpuSpawnEventComputeCache = { key: cacheKey, node };
    }

    renderer.compute(this._gpuSpawnEventComputeCache.node);
  }

  private _getGPUEmissionFinalizeComputeNodes(
    context: GPUParticleUpdateContext,
    emitters: Emitter[],
    emitterInstances: GPUEmitterInstanceBufferState,
  ): ComputeNode[] {
    const cacheKey = [
      'emission-finalize',
      `instances:${emitterInstances.capacity}`,
      `culling:${this.maxCullingMode}`,
      `defer:${context.buffers.capacity < this.maxParticles}`,
      `emitters:${emitters.map((emitter) => `${this._getObjectSignature(emitter)}@${emitter.version}`).join(',')}`,
    ].join('|');
    if (this._gpuEmissionFinalizeComputeCache?.key === cacheKey) {
      return this._gpuEmissionFinalizeComputeCache.nodes;
    }

    this._gpuEmissionFinalizeComputeCache?.nodes.forEach((node) => node.dispose?.());
    const nodes = emitters.map((_emitter, emitterIndex) => Fn(() => {
      const runtime = emitterInstances.createRuntime(emitterIndex);
      const requested = runtime.requestCount();
      const deadClaims = runtime.claimCount();
      const deadSuccesses = deadClaims.lessThan(requested).select(deadClaims, requested) as Node<'uint'>;
      const afterDead = requested.sub(deadSuccesses);
      const replacementClaims = runtime.replacementCount();
      const replacementSuccesses = this.maxCullingMode === MaxCulling.Old
        ? replacementClaims.lessThan(afterDead).select(replacementClaims, afterDead) as Node<'uint'>
        : uint(0);
      const failures = afterDead.sub(replacementSuccesses);
      context.allocationWriter?.recordAllocationFailures(failures);
      runtime.setPendingRequestCount(
        context.buffers.capacity < this.maxParticles ? failures : uint(0),
      );
    })().compute(1));

    this._gpuEmissionFinalizeComputeCache = { key: cacheKey, nodes };
    this._gpuPipelineBuildCount += nodes.length;
    return nodes;
  }

  private _getGPUEmissionPrepareComputeNodes(
    context: GPUParticleUpdateContext,
    emitters: Emitter[],
    emitterInstances: GPUEmitterInstanceBufferState,
  ): ComputeNode[] {
    const cacheKey = [
      'emission-prepare',
      `instances:${emitterInstances.capacity}`,
      `emitters:${emitters.map((emitter) => `${this._getObjectSignature(emitter)}@${emitter.version}`).join(',')}`,
    ].join('|');

    if (this._gpuEmissionPrepareComputeCache?.key === cacheKey) {
      return this._gpuEmissionPrepareComputeCache.nodes;
    }

    this._gpuEmissionPrepareComputeCache?.nodes.forEach((node) => node.dispose?.());
    this._gpuEmissionFinalizeComputeCache?.nodes.forEach((node) => node.dispose?.());
    const nodes = emitters.map((emitter, emitterIndex) => Fn(() => {
      emitter.prepareBuiltInGPUEmission({
        ...context,
        emitter,
        emitterIndex,
        output: context.buffers,
        emitterRuntime: emitterInstances.createRuntime(emitterIndex),
        durationNode: this._gpuDurationNode,
        tagMasks: this._getGPUEmitterTagMasks(emitter),
      });
    })().compute(1));

    this._gpuEmissionPrepareComputeCache = { key: cacheKey, nodes };
    this._gpuPipelineBuildCount += nodes.length;
    return nodes;
  }

  private _computeStagedBirths(context: GPUParticleUpdateContext): void {
    const renderer = this.sceneRenderer;
    if (!this._stagedBirths.length || !isWebGPURenderer(renderer)) return;
    const count = Math.min(this._stagedBirths.length, context.buffers.capacity);
    const capacity = nextPowerOfTwo(count);
    if (!this._stagedBirthBuffers || this._stagedBirthBuffers.capacity < capacity) {
      this._stagedBirthBuffers?.dispose(renderer);
      this._stagedBirthBuffers = createEmptyGPUParticleBufferState(capacity);
    }
    const births = this._stagedBirthBuffers;
    births.upload(this._stagedBirths.slice(0, count), p => this._getParticleGPUTagMask(p));
    births.initialize(renderer);
    this._stagedBirthCount.value = count;
    const key =
      `${births.capacity}:${context.buffers.version}:${context.buffers.capacity}:${context.eventWriter?.version}`;
    if (this._stagedBirthCompute?.key !== key) {
      this._stagedBirthCompute?.nodes.forEach(node => node.dispose());
      const node = Fn(() => {
        const particle = context.buffers.storage.createParticle(undefined, true);
        context.allocationWriter!.claimDeadSlotForEmitter(particle, this._stagedBirthCount,
          () => context.allocationWriter!.claimEmissionRun(), claim => {
            const birth = births.storage.createParticle(claim);
            context.buffers.storage.storeParticle(Object.assign(birth, { index: particle.index,
              generation: particle.generation, alive: uint(1) }));
            context.allocationWriter!.markSpawned(particle);
          });
      })().compute(context.buffers.capacity);
      const reset = Fn(() => { context.allocationWriter!.resetEmissionRunClaims(); })().compute(1);
      this._stagedBirthCompute = { key, nodes: [reset, node] };
    }
    this._stagedBirthCompute.nodes.forEach(node => renderer.compute(node));
    this._stagedBirths.length = 0;
  }

  private _computeGPUContinuousSubSystemEmissionPhase(
    context: GPUParticleUpdateContext,
    input: GPUSubSystemFrameInput,
  ): void {
    const parentBuffers = input.parent._gpuBuffers;
    const renderer = this.sceneRenderer;
    if (!parentBuffers || !isWebGPURenderer(renderer)) return;

    const emitters = this.emitters;
    if (emitters.length === 0) return;

    const contextCount = parentBuffers.capacity * emitters.length;
    const emitterInstances = this._acquireGPUEmitterInstances(
      'continuous',
      contextCount + emitters.length,
      emitters,
      renderer,
    );
    const cacheKey = [
      'continuous-subsystem',
      `parent:${parentBuffers.version}:${parentBuffers.capacity}`,
      `child:${context.buffers.version}:${context.buffers.capacity}`,
      `instances:${emitterInstances.capacity}`,
      `options:${this._getSubSystemGPUOptionsSignature(input.options)}`,
      `emitters:${emitters.map((emitter) => `${this._getObjectSignature(emitter)}@${emitter.version}`).join(',')}`,
    ].join('|');

    if (this._gpuContinuousSubSystemComputeCache?.key !== cacheKey) {
      this._gpuPipelineBuildCount += 1;
      this._gpuContinuousSubSystemComputeCache?.nodes.forEach((node) => node.dispose?.());
      const nodes: ComputeNode[] = [];

      emitters.forEach((emitter, emitterIndex) => {
        const globalRuntime = emitterInstances.createRuntime(contextCount + emitterIndex);
        nodes.push(Fn(() => {
          globalRuntime.resetRequestCount(uint(0));
        })().compute(1));

        nodes.push(Fn(() => {
          const parent = parentBuffers.storage.createParticle(undefined, true);
          const runtimeIndex = instanceIndex.mul(emitters.length).add(emitterIndex);
          const runtime = emitterInstances.createRuntime(runtimeIndex);
          const ratioEligible = input.options.ratio >= 1
            ? uint(1).equal(uint(1))
            : hash(instanceIndex.add(parent.generation.mul(65537))).lessThanEqual(float(input.options.ratio));
          const predicateEligible = typeof input.options.shouldEmit === 'boolean'
            ? input.options.shouldEmit
            : false;
          const eligible = parent.alive.notEqual(uint(0))
            .and(ratioEligible)
            .and(predicateEligible)
            .and(input.options.tags
              ? parent.tagMask.bitAnd(uint(this._getGPUTagMask(input.options.tags) ?? 0)).notEqual(uint(0))
              : true);

          If(eligible, () => {
            const identityChanged = runtime.identity.x.equal(uint(0))
              .or(runtime.identity.y.notEqual(parent.index))
              .or(runtime.identity.z.notEqual(parent.generation));
            If(identityChanged, () => {
              runtime.identity.x.assign(uint(0));
              runtime.identity.y.assign(parent.index);
              runtime.identity.z.assign(parent.generation);
              runtime.identity.w.assign(uint(emitterIndex));
            });

            emitter.prepareBuiltInGPUEmission({
              ...context,
              elapsedTimeNode: runtime.timing.w.add(context.deltaTimeNode),
              durationNode: mix(
                this._gpuDurationNode,
                parent.lifetime,
                float(input.options.inheritLifetime),
              ),
              normalizedTimeNode: input.options.inheritLifetime > 0
                ? parent.time.mul(input.options.inheritLifetime)
                : undefined,
              emitterPositionNode: parent.position,
              emitter,
              emitterIndex,
              output: context.buffers,
              emitterRuntime: runtime,
            });
            const requestCount = runtime.requestCount();
            const requestOffset = globalRuntime.reserveRequestCount(requestCount);
            Loop({ start: 0, end: requestCount, type: 'uint' }, ({ i }) => {
              context.allocationWriter?.storeEmissionSource(requestOffset.add(i), parent.index);
            });
          }).Else(() => {
            runtime.identity.x.assign(uint(0));
            runtime.resetRequestCount(uint(0));
          });
        })().compute(parentBuffers.capacity));

        const emitGPU = emitter.createBuiltInGPUUpdate()!;
        nodes.push(Fn(() => {
          const resolveParentSlot = (claimIndex: Node<'uint'>): Node<'uint'> => (
            context.allocationWriter!.emissionSource(claimIndex)
          );

          emitGPU({
            ...context,
            emitter,
            emitterIndex,
            output: context.buffers,
            emitterRuntime: globalRuntime,
            tagMasks: this._getGPUEmitterTagMasks(emitter),
            inheritance: {
              color: input.options.inheritColor,
              alpha: input.options.inheritAlpha,
              mass: input.options.inheritMass,
              velocity: input.options.inheritVelocity,
              scale: input.options.inheritScale,
            },
            resolveParentParticle: (claimIndex) => parentBuffers.storage.createParticle(
              resolveParentSlot(claimIndex),
              true
            ),
            resolveEmissionTime: (claimIndex) => {
              const parentSlot = resolveParentSlot(claimIndex);
              if (input.options.inheritLifetime > 0) {
                return parentBuffers.storage.createParticle(parentSlot, true).time
                  .mul(input.options.inheritLifetime);
              }
              const runtimeIndex = parentSlot.mul(emitters.length).add(emitterIndex);
              return emitterInstances.createRuntime(runtimeIndex).timing.w
                .div(this._gpuDurationNode);
            },
          });
        })().compute(context.buffers.capacity));
      });

      this._gpuContinuousSubSystemComputeCache = { key: cacheKey, nodes };
    }

    this._gpuContinuousSubSystemComputeCache.nodes.forEach((node) => renderer.compute(node));
  }

  private _computeGPUEventSubSystemEmissionPhase(
    context: GPUParticleUpdateContext,
    input: GPUSubSystemFrameInput,
  ): void {
    const eventBuffer = input.parent._gpuFrameEventBuffer;
    const renderer = this.sceneRenderer;
    if (!eventBuffer || !isWebGPURenderer(renderer)) return;

    const emitters = this.emitters;
    if (emitters.length === 0) return;

    const runs = this._acquireGPUEmissionRuns(
      Math.min(eventBuffer.capacity, Math.max(this.maxParticles, 1)),
      renderer,
    );
    const contextCount = runs.capacity * emitters.length;
    const emitterInstances = this._acquireGPUEmitterInstances(
      'event',
      contextCount + emitters.length,
      emitters,
      renderer,
    );
    const reader = eventBuffer.createReader();
    const cacheKey = [
      'event-subsystem',
      `events:${eventBuffer.version}:${eventBuffer.capacity}`,
      `runs:${runs.capacity}`,
      `child:${context.buffers.version}:${context.buffers.capacity}`,
      `instances:${emitterInstances.capacity}`,
      `options:${this._getSubSystemGPUOptionsSignature(input.options)}`,
      `emitters:${emitters.map((emitter) => `${this._getObjectSignature(emitter)}@${emitter.version}`).join(',')}`,
    ].join('|');

    if (this._gpuEventSubSystemComputeCache?.key !== cacheKey) {
      this._gpuPipelineBuildCount += 1;
      this._gpuEventSubSystemComputeCache?.nodes.forEach((node) => node.dispose?.());
      const nodes: ComputeNode[] = [];

      nodes.push(Fn(() => context.allocationWriter?.resetEmissionRunClaims())().compute(1));
      nodes.push(Fn(() => {
        const run = runs.load(instanceIndex);
        const eventCount = reader.count().toVar('subsystemEventCount');
        If(run.active.equal(uint(0)), () => {
          Loop({ start: 0, end: eventCount, type: 'uint' }, () => {
            const eventIndex = context.allocationWriter!.claimEmissionRun().toVar('eventRunClaim');
            If(eventIndex.lessThan(eventCount), () => {
              const event = reader.load(eventIndex);
              let typeEligible = uint(0).equal(uint(1));
              for (const [name, type] of input.parent._eventTypes) {
                if (input.parent._subscribes(input.options, name) && this._canHandleNativeGPUEvent(input.parent,
                  input.options, name)) {
                  typeEligible = typeEligible.or(event.type.equal(uint(type)));
                }
              }
              if (input.options.tags) typeEligible =
                typeEligible.and(event.particle.tagMask
                  .bitAnd(uint(this._getGPUTagMask(input.options.tags) ?? 0)).notEqual(uint(0)));
              const ratioEligible = input.options.ratio >= 1
                ? uint(1).equal(uint(1))
                : hash(event.slot.add(event.generation.mul(65537))).lessThanEqual(float(input.options.ratio));
              const predicateEligible = typeof input.options.shouldEmit === 'boolean'
                ? input.options.shouldEmit
                : false;
              const impulseEligible = event.type.notEqual(uint(GPUEventType.Collision))
                .or(event.collisionImpulse.length().greaterThan(float(input.options.impulseThreshold)));

              If(typeEligible.and(ratioEligible).and(predicateEligible).and(impulseEligible), () => {
                const impulseDuration = input.options.impulseAffectsLifetime > 0
                  ? event.type.equal(uint(GPUEventType.Collision)).select(
                    pow(event.collisionImpulse.length().max(float(0)), float(input.options.impulseAffectsLifetime)),
                    float(0),
                  ) as Node<'float'>
                  : float(0);
                const duration = mix(
                  this._gpuDurationNode,
                  event.particle.lifetime,
                  float(input.options.inheritLifetime),
                ).add(impulseDuration);

                const transformScale = mix(vec3(1), event.particle.scale, float(Math.max(0,
                  input.options.inheritScale)));
                const rotate = (v: Node<'vec3'>): Node<'vec3'> => {
                  const base = rotateEulerYXZGPU(v, event.particle.rotation);
                  return input.options.impulseAffectsAlignment
                    ? event.collisionImpulse.length().greaterThan(0).select(rotateFromYGPU(v,
                      event.collisionImpulse), base) as Node<'vec3'>
                    : base;
                };
                const transform = mat4(
                  vec4(rotate(vec3(transformScale.x, 0, 0)), 0),
                  vec4(rotate(vec3(0, transformScale.y, 0)), 0),
                  vec4(rotate(vec3(0, 0, transformScale.z)), 0), vec4(event.particle.position, 1));
                const impulseMass = event.type.equal(uint(GPUEventType.Collision)).select(
                  pow(event.collisionImpulse.length().max(0), Math.max(0, input.options.impulseAffectsMass)), float(1));
                const resolved: GPUEmissionContext = {
                  transform,
                  position: event.particle.position,
                  color: mix(vec3(1), event.particle.color, float(Math.max(0, input.options.inheritColor))),
                  alpha: mix(float(1), event.particle.alpha, float(Math.max(0, input.options.inheritAlpha))),
                  mass: mix(float(1), event.particle.mass, float(Math.max(0,
                    input.options.inheritMass))).mul(impulseMass),
                  velocity: event.particle.velocity.mul(Math.max(0, input.options.inheritVelocity)),
                  scale: event.type.equal(uint(GPUEventType.Collision)).select(
                    pow(event.collisionImpulse.length().max(0), input.options.impulseAffectsScale),
                      float(1)) as Node<'float'>,
                  velocityScale: event.type.equal(uint(GPUEventType.Collision)).select(
                    pow(event.collisionImpulse.length().max(0), input.options.impulseAffectsSpeed),
                      float(1)) as Node<'float'>,
                  distortionStrength: float(1),
                  duration,
                };
                const contextValues = Object.fromEntries(Object.entries(resolved).map(([key, node]) => [key,
                  node.toVar(`eventContext_${key}`)])) as unknown as GPUEmissionContext;
                const subscriptions = input.options.onEvent;
                if (subscriptions && !Array.isArray(subscriptions)) {
                  for (const [name, handler] of Object.entries(subscriptions.gpu ?? {})) {
                    const type = input.parent._eventTypes.get(name)!;
                    If(event.type.equal(uint(type)), () => {
                      const overrides = handler(event.data, event.particle, contextValues);
                      if (overrides) {
                        for (const [key, value] of Object.entries(overrides)) {
                          (contextValues[key as keyof GPUEmissionContext] as Node).assign(value);
                        }
                        if (overrides.position && !overrides.transform) matrixColumn(contextValues.transform,
                          3).assign(vec4(overrides.position, 1));
                        if (overrides.transform &&
                          !overrides.position) contextValues.position.assign(matrixColumn(overrides.transform, 3).xyz);
                      }
                    });
                  }
                }
                runs.storeParticle(instanceIndex, {
                  ...event.particle,
                  alive: uint(1),
                  realtime: float(0), lifetime: contextValues.duration,
                  position: contextValues.position, rotation: event.collisionNormal,
                  scale: transformScale, color: contextValues.color,
                  alpha: contextValues.alpha, mass: contextValues.mass,
                  velocity: contextValues.velocity,
                  speed: contextValues.scale, distortionStrength: contextValues.velocityScale,
                  // Event-specific values are resolved now; the payload need not survive in run storage.
                  acceleration: matrixColumn(contextValues.transform, 0).xyz,
                  angularAcceleration: matrixColumn(contextValues.transform, 1).xyz,
                  scalarAcceleration: matrixColumn(contextValues.transform, 2).xyz,
                  angularVelocity: matrixColumn(contextValues.transform, 3).xyz,
                  scalarVelocity: event.collisionImpulse,
                  orbitCenter: event.collisionPoint, lodPriority: event.type,
                  time: contextValues.distortionStrength,
                });
                Break();
              });
            }).Else(() => { Break(); });
          });
        });
      })().compute(runs.capacity));

      nodes.push(Fn(() => {
        const run = runs.load(instanceIndex);
        If(run.active.notEqual(uint(0)), () => {
          run.elapsed.addAssign(context.deltaTimeNode);
        });
      })().compute(runs.capacity));

      emitters.forEach((emitter, emitterIndex) => {
        const globalRuntime = emitterInstances.createRuntime(contextCount + emitterIndex);
        nodes.push(Fn(() => globalRuntime.resetRequestCount(uint(0)))().compute(1));
        nodes.push(Fn(() => {
          const run = runs.load(instanceIndex);
          const runtimeIndex = instanceIndex.mul(emitters.length).add(emitterIndex);
          const runtime = emitterInstances.createRuntime(runtimeIndex);

          If(run.active.notEqual(uint(0)), () => {
            If(run.elapsed.lessThan(run.duration), () => {
              emitter.prepareBuiltInGPUEmission({
                ...context,
                elapsedTimeNode: run.elapsed,
                durationNode: run.duration,
                emitterPositionNode: run.particle.position,
                emitter,
                emitterIndex,
                output: context.buffers,
                emitterRuntime: runtime,
              });
              const requestCount = runtime.requestCount();
              const requestOffset = globalRuntime.reserveRequestCount(requestCount);
              Loop({ start: 0, end: requestCount, type: 'uint' }, ({ i }) => {
                context.allocationWriter?.storeEmissionSource(requestOffset.add(i), instanceIndex);
              });
            }).Else(() => {
              runtime.identity.x.assign(uint(0));
              runtime.resetRequestCount(uint(0));
            });
          }).Else(() => {
            runtime.identity.x.assign(uint(0));
            runtime.resetRequestCount(uint(0));
          });
        })().compute(runs.capacity));

        const emitGPU = emitter.createBuiltInGPUUpdate()!;
        nodes.push(Fn(() => {
          const resolveRunIndex = (claimIndex: Node<'uint'>): Node<'uint'> => (
            context.allocationWriter!.emissionSource(claimIndex)
          );

          emitGPU({
            ...context,
            emitter,
            emitterIndex,
            output: context.buffers,
            emitterRuntime: globalRuntime,
            tagMasks: this._getGPUEmitterTagMasks(emitter),
            inheritance: { color: 1, alpha: 1, mass: 1, velocity: 1, scale: 1 },
            resolveParentParticle: (claimIndex) => runs.load(resolveRunIndex(claimIndex)).particle,
            resolveDistortionStrength: claimIndex => runs.load(resolveRunIndex(claimIndex)).particle.time,
            resolveEmissionTransform: claimIndex => {
              const p = runs.load(resolveRunIndex(claimIndex)).particle;
              return mat4(vec4(p.acceleration, 0), vec4(p.angularAcceleration, 0),
                vec4(p.scalarAcceleration, 0), vec4(p.angularVelocity, 1));
            },
            resolveEmissionTime: (claimIndex) => {
              const run = runs.load(resolveRunIndex(claimIndex));
              return run.elapsed.div(run.duration.max(float(Number.EPSILON)));
            },
            resolveImpulseEffects: (claimIndex) => {
              const run = runs.load(resolveRunIndex(claimIndex));
              return {
                scale: run.particle.speed,
                speed: run.particle.distortionStrength,
                mass: float(1),
                alignmentDirection: undefined,
              };
            },
          });
        })().compute(context.buffers.capacity));
      });

      nodes.push(Fn(() => {
        const run = runs.load(instanceIndex);
        If(run.active.notEqual(uint(0)).and(run.elapsed.greaterThanEqual(run.duration)), () => {
          run.active.assign(uint(0));
        });
      })().compute(runs.capacity));

      this._gpuEventSubSystemComputeCache = { key: cacheKey, nodes };
    }

    this._gpuEventSubSystemComputeCache.nodes.forEach((node) => renderer.compute(node));
  }

  private _computeGPUSimulationPhase(
    context: GPUParticleUpdateContext,
    permanentModifiers: Array<Module | SpatialEffect>,
    transientPreMovementModifiers: Array<Module | SpatialEffect>,
  ): void {
    const buffers = context.buffers;
    if (!buffers.count) return;
    if (!isWebGPURenderer(this.sceneRenderer)) return;

    const computeNode = this._getGPUSimulationComputeNode(
      context,
      permanentModifiers,
      transientPreMovementModifiers,
    );

    this.sceneRenderer.compute(computeNode);
  }

  private _computeGPUCollisionAndModifierPhases(
    context: GPUParticleUpdateContext,
    modifiers: Array<Module | SpatialEffect>,
  ): Array<Module | SpatialEffect> {
    const renderer = this.sceneRenderer;
    if (!isWebGPURenderer(renderer)) return modifiers;

    let pending: Array<Module | SpatialEffect> = [];
    this._gpuSpatialBuildSequence += 1;
    const builtGrids = new Set<ParticleSpatialGrid>();
    for (const modifier of modifiers) {
      const grid = modifier instanceof Module
        ? modifier.getParticleSpatialGrid(this)
        : undefined;
      if (!(modifier instanceof Collision) && !grid) {
        pending.push(modifier);
        continue;
      }

      if (pending.length > 0) {
        renderer.compute(this._getGPUStoredModifierNode(context, pending));
        pending = [];
      }

      if (grid && !builtGrids.has(grid)) {
        grid.rebuild(renderer, context.buffers, this._gpuSpatialBuildSequence);
        builtGrids.add(grid);
      }

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

  private _getGPUStoredModifierNode(
    context: GPUParticleUpdateContext,
    modifiers: Array<Module | SpatialEffect>,
  ): ComputeNode {
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

  private _getGPUCollisionNode(
    context: GPUParticleUpdateContext,
    collision: Collision,
  ): ComputeNode {
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
      const matches = tagMask === undefined
        ? particle.alive.notEqual(uint(0))
        : particle.alive.notEqual(uint(0))
          .and(particle.tagMask.bitAnd(uint(tagMask)).notEqual(uint(0)));
      If(matches, () => {
        collision.modifyGPUCollision(particle, context);
        buffers.storage.storeParticle(particle);
      });
    })().compute(buffers.count);
    this._gpuModifierComputeCaches.set(key, { key, node });
    return node;
  }

  private _getGPUCollisionDetectionNode(
    context: GPUParticleUpdateContext,
    collision: Collision,
  ): ComputeNode {
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
      const matches = tagMask === undefined
        ? particle.alive.notEqual(uint(0))
        : particle.alive.notEqual(uint(0))
          .and(particle.tagMask.bitAnd(uint(tagMask)).notEqual(uint(0)));
      If(matches, () => collision.detectGPUCollision(particle, context));
    })().compute(buffers.count);
    this._gpuModifierComputeCaches.set(key, { key, node });
    return node;
  }

  private _getGPUCollisionResolutionNode(
    context: GPUParticleUpdateContext,
    collision: Collision,
  ): ComputeNode {
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
      const particle = buffers.storage.createParticle();
      const event = marker.load(particle.index);
      If(particle.alive.notEqual(uint(0)).and(event.active), () => {
        collision.resolveGPUCollision(particle, context, event.position, event.normal);
      });
    })().compute(buffers.count);
    this._gpuModifierComputeCaches.set(key, { key, node });
    return node;
  }

  private _getGPUCollisionEventNode(
    context: GPUParticleUpdateContext,
    collision: Collision,
  ): ComputeNode {
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
        );
        marker.clear(particle.index);
      });
    })().compute(buffers.count);
    this._gpuModifierComputeCaches.set(key, { key, node });
    return node;
  }

  private _getGPUSimulationComputeNode(
    context: GPUParticleUpdateContext,
    permanentModifiers: Array<Module | SpatialEffect>,
    transientPreMovementModifiers: Array<Module | SpatialEffect>,
  ): ComputeNode {
    const buffers = context.buffers;
    const cacheKey = [
      'simulation',
      `buffer:${buffers.version}:${buffers.capacity}`,
      `count:${buffers.count}`,
      `gravityModifier:${this._getDynamicValueSignature(this.gravityModifier)}`,
      `events:${context.eventWriter?.version ?? 'none'}:${context.eventWriter?.capacity ?? 0}`,
      this._getGPUSpatialRegistrySignature(),
      `permanent:${this._getGPUModifierListSignature(permanentModifiers)}`,
      `transient:${this._getGPUModifierListSignature(transientPreMovementModifiers)}`,
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

        const base = transientPreMovementModifiers.length > 0
          ? this._snapshotGPUParticle(particle)
          : undefined;

        this._applyGPUModifiers(transientPreMovementModifiers, particle, context);

        this._integrateGPUParticle(particle, context);

        if (base) {
          this._commitGPUTransientParticle(particle, base);
        }

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

  private _computeGPURenderOutputPhase(
    source: GPUParticleBufferState,
    target: GPUParticleRenderBufferState,
    modifiers: Array<Module | SpatialEffect>,
    context: GPUParticleUpdateContext,
  ): void {
    if (!source.count) return;
    if (!isWebGPURenderer(this.sceneRenderer)) return;

    const computeNode = this._getGPURenderOutputComputeNode(source, target, modifiers, context);

    this.sceneRenderer.compute(computeNode);
  }

  private _getGPURenderOutputComputeNode(
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

      this._applyGPUModifiers(modifiers, particle, context);

      target.storage.storeParticle(particle);
    })().compute(source.count);

    this._gpuRenderOutputComputeCache = {
      key: cacheKey,
      node: computeNode,
    };
    this._gpuPipelineBuildCount += 1;

    return computeNode;
  }

  private _updateGPURuntimeUniforms(): void {
    this._gpuDeltaTimeNode.value = this.deltaTime;
    this._gpuElapsedTimeNode.value = this._elapsedTime;
    this._gpuDurationNode.value = Math.max(this.duration, Number.EPSILON);
    this._gpuGravityNode.value.copy(this.gravity);
    this.updateWorldMatrix(true, false);
    if (this.simulationSpace === SimulationSpace.World) {
      this._gpuSimulationToWorldNode.value.identity();
      this._gpuWorldToSimulationNode.value.identity();
    } else {
      this._gpuSimulationToWorldNode.value.copy(this.matrixWorld);
      this._gpuWorldToSimulationNode.value.copy(this.matrixWorld).invert();
    }
    if (this.simulationSpace === SimulationSpace.World) {
      this._gpuEmitterPositionNode.value.setFromMatrixPosition(this.matrixWorld);
    } else {
      this._gpuEmitterPositionNode.value.set(0, 0, 0);
    }
    this.emitters.forEach((emitter) => emitter.updateGPUQuality(this.quality));
  }

  private _getGPUModifierListSignature(modifiers: Array<Module | SpatialEffect>): string {
    const signatures: string[] = [`events:${Array.from(this._eventTypes).join(',')}`];
    for (let index = 0; index < modifiers.length;) {
      const modifier = modifiers[index];
      const record = modifier instanceof SpatialEffect && isBatchableEffect(modifier)
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
        const nextRecord = next instanceof SpatialEffect && isBatchableEffect(next)
          ? this._gpuSpatialRegistry?.getRecord(next)
          : undefined;
        if (!nextRecord || nextRecord.segmentId !== record.segmentId) break;
        index += 1;
      }
    }
    return signatures.join(',');
  }

  private _getGPUSpatialRegistrySignature(): string {
    const registry = this._gpuSpatialRegistry;
    if (!registry || registry.records.length <= 0) return 'spatial:none';
    const records = registry.records.map((record) => record.effect.version).join(',');
    return `spatial:${registry.version}:${registry.signature}:${records}`;
  }

  private _getGPUModifierSignature(modifier: Module | SpatialEffect): string {
    if (modifier instanceof SpatialEffect) modifier.updateWorldMatrix(true, false);
    const tagMask = this._getGPUTagMask(modifier.tags);
    const type = modifier instanceof Module ? 'module' : 'spatial';

    let instanceState = 'parameterized';
    if (modifier instanceof SpatialEffect) {
      const spatialEffect: SpatialEffect = modifier;
      const batchable = spatialEffect.supportsGPU
        && Boolean(spatialEffect.gpuSpatialType?.testGPU && spatialEffect.writeGPUParameters);
      if (!batchable) {
        instanceState = [
          spatialEffect.visible ? 1 : 0,
          spatialEffect.feather,
          spatialEffect.inverted ? 1 : 0,
        ].join(':');
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

  private _getDynamicValueSignature(value: DynamicValue<number> | undefined): string {
    if (value === undefined) return 'undefined';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'function') return 'function';
    if (Array.isArray(value)) return `array:${value.map((item) => this._getDynamicValueSignature(item)).join(',')}`;
    if (value instanceof Set) {
      return `set:${Array.from(value).map((item) => this._getDynamicValueSignature(item)).join(',')}`;
    }
    if (typeof value === 'object' && value !== null) return `object:${this._getObjectSignature(value)}`;
    return typeof value;
  }

  private _getObjectSignature(value: object): number {
    let id = this._gpuObjectIds.get(value);
    if (id === undefined) {
      id = this._nextGPUModifierId;
      this._nextGPUModifierId += 1;
      this._gpuObjectIds.set(value, id);
    }

    return id;
  }

  private _disposeGPUComputeCaches(): void {
    this._gpuLODCull?.node.dispose();
    this._gpuLODCull = undefined;
    this._gpuEmissionPrepareComputeCache?.nodes.forEach((node) => node.dispose?.());
    this._gpuContinuousSubSystemComputeCache?.nodes.forEach((node) => node.dispose?.());
    this._gpuEventSubSystemComputeCache?.nodes.forEach((node) => node.dispose?.());
    this._gpuEmissionComputeCache?.nodes.forEach((node) => node.dispose?.());
    this._gpuOldEmissionComputeCache?.nodes.forEach((node) => node.dispose?.());
    this._gpuOldSelectionComputeCache?.nodes.forEach((node) => node.dispose?.());
    this._gpuOldDeathEventComputeCache?.node.dispose?.();
    this._gpuAllocationSnapshotComputeCache?.node.dispose?.();
    this._gpuSpawnEventComputeCache?.node.dispose?.();
    this._gpuSimulationComputeCaches.forEach((cache) => cache.node.dispose?.());
    this._gpuModifierComputeCaches.forEach((cache) => cache.node.dispose?.());
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

  private _integrateGPUParticle(
    particle: GPUParticleLike,
    context: GPUParticleUpdateContext,
  ): void {
    const deltaTime = this._gpuDeltaTimeNode;
    const gravity = this._gpuGravityNode;
    const gravityModifier = this._gpuParameters.number(
      'gravityModifier.integrate',
      () => this.gravityModifier,
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

    context.allocationWriter?.recordActive(particle);
  }

  private _scheduleGPUAllocationReadback(
    allocationBuffer: GPUAllocationBufferState,
    renderer: WebGPURenderer,
  ): void {
    const now = performance.now();
    if (
      !renderer.backend
      || typeof renderer.getArrayBufferAsync !== 'function'
      || this._gpuAllocationReadbackPending
      || now - this._lastGPUAllocationReadbackTime < (
        this.spatialEffectBoundsFiltering
          ? 1000 / Math.max(ParticleSystem.GPU_READBACK_RATE, 1)
          : 250
      )
    ) return;

    this._gpuAllocationReadbackPending = true;
    this._lastGPUAllocationReadbackTime = now;
    const lifecycleGeneration = this._gpuLifecycleGeneration;
    void allocationBuffer.readback(renderer)
      .then((diagnostics) => {
        if (lifecycleGeneration !== this._gpuLifecycleGeneration) return;
        this._gpuAllocationDiagnostics = diagnostics;
        if (
          this._gpuBuffers
          && this._gpuBuffers.capacity < this.maxParticles
          && (diagnostics.allocationFailures > 0 || diagnostics.recycledDeaths > 0)
        ) {
          const nextCapacity = Math.min(
            this.maxParticles,
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

  private _snapshotGPUParticle(particle: GPUParticleLike): GPUParticleLike {
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
    };
  }

  private _commitGPUTransientParticle(frame: GPUParticleLike, base: GPUParticleLike): void {
    const deltaTime = this._gpuDeltaTimeNode;
    const gravity = this._gpuGravityNode;
    const frameStep = deltaTime.mul(frame.speed);
    const baseStep = deltaTime.mul(base.speed);
    const gravityModifier = this._gpuParameters.number(
      'gravityModifier.transient',
      () => this.gravityModifier,
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

  private _cloneParticlesForGPUReadback(particles: Particle[]): Particle[] {
    return particles.map((particle) => {
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

  private _applyGPUModifier(
    modifier: Module | SpatialEffect,
    particle: GPUParticleLike,
    context: GPUParticleUpdateContext,
  ): void {
    const alive = particle.alive.notEqual(uint(0));

    if (modifier instanceof Module) {
      const tagMask = this._getGPUTagMask(modifier.tags);
      const spatialGrid = modifier.getParticleSpatialGrid(this);
      const modifyParticle = () => {
        modifier.modifyGPU(
          particle,
          context.deltaTimeNode,
          context,
          spatialGrid,
        );
      };
      const modifySelectedParticle = modifier.conditionGPU
        ? () => If(
          modifier.conditionGPU!(particle, context.deltaTimeNode, context, spatialGrid),
          modifyParticle,
        )
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

  private _applyGPUModifiers(
    modifiers: Array<Module | SpatialEffect>,
    particle: GPUParticleLike,
    context: GPUParticleUpdateContext,
  ): void {
    const registeredTagMask = (tag: Tag): number => {
      const index = this._gpuTagRegistry.get(tag);
      if (index === undefined) throw new Error(`GPU particle tag "${tag}" is not registered in this system.`);
      return (2 ** index) >>> 0;
    };
    particle.addTag = tag => {
      particle.tagMask.assign(particle.tagMask.bitOr(uint(registeredTagMask(tag))));
    };
    particle.removeTag = tag => {
      particle.tagMask.assign(particle.tagMask.bitAnd(uint((~registeredTagMask(tag)) >>> 0)));
    };
    particle.emitEvent = (event, payload) => {
      if (Array.isArray(payload) &&
        payload.length > 3) throw new Error('GPU custom event payload accepts at most three vec4 values (12 floats).');
      const type = this._eventTypes.get(event);
      if (type !== undefined) context.eventWriter?.emitParticleEvent(type, particle, payload);
    };
    for (let index = 0; index < modifiers.length;) {
      const modifier = modifiers[index];
      const firstRecord = modifier instanceof SpatialEffect && isBatchableEffect(modifier)
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
        context,
      );
      index = nextIndex;
    }
  }

  private _applyGPUSpatialRecord(
    record: GPUSpatialEffectRecord,
    particle: GPUParticleLike,
    context: GPUParticleUpdateContext,
  ): void {
    const registry = this._gpuSpatialRegistry;
    if (!registry || !record.enabled) return;

    const type = registry.types[record.typeId];
    if (!type) return;

    const alive = particle.alive.notEqual(uint(0));
    const tagMatch = record.tagMask === 0
      ? alive
      : alive.and(particle.tagMask.bitAnd(uint(record.tagMask)).notEqual(uint(0)));
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

  private _modifyGPUSpatialEffect(
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

  private _beginGPUDebugFrame(modules: Module[]): number | undefined {
    this._gpuDebugFrame += 1;

    if (!this._isGPUDebugEnabled()) return undefined;

    const interval = Math.max(1, this.gpuDebugInterval || ParticleSystem.GPU_DEBUG_INTERVAL);
    if (this._gpuDebugFrame % interval !== 0) return undefined;

    this._gpuDebugActiveFrame = this._gpuDebugFrame;
    this._logGPUDebug('begin', {
      deltaTime: this.deltaTime,
      particleCount: this.particles.length,
      renderer: this.sceneRenderer?.constructor.name,
      modules: this._describeGPUModules(modules),
      tagRegistry: Array.from(this._gpuTagRegistry.entries()),
      tagOverflow: this._gpuTagOverflow,
    });

    return this._gpuDebugFrame;
  }

  private _endGPUDebugFrame(frame: number | undefined): void {
    if (frame === undefined) return;

    this._logGPUDebug('end', {
      particleCount: this.particles.length,
      sample: this._sampleGPUParticles(this.particles),
    });

    if (this._gpuDebugActiveFrame === frame) {
      this._gpuDebugActiveFrame = undefined;
    }
  }

  private _isGPUDebugEnabled(): boolean {
    return this.gpuDebug || ParticleSystem.GPU_DEBUG;
  }

  private _logGPUDebug(message: string, data?: unknown): void {
    if (this._gpuDebugActiveFrame === undefined) return;

    const prefix = `[RZMPS GPU frame ${this._gpuDebugActiveFrame}] ${message}`;
    if (data === undefined) {
      console.debug(prefix);
      return;
    }

    console.debug(prefix, data);
  }

  private _describeGPUModules(modules: Module[]): Array<{
    name: string;
    priority: number;
    tags?: Tag[];
    supportsGPU: boolean;
  }> {
    return modules.map((module) => ({
      name: module.constructor.name,
      priority: module.priority,
      tags: module.tags ? [...module.tags] : undefined,
      supportsGPU: module.supportsGPU,
    }));
  }

  private _describeGPUModifiers(modifiers: Array<Module | SpatialEffect>): Array<{
    name: string;
    priority: number;
    tags?: Tag[];
    supportsGPU: boolean;
    type: 'module' | 'spatialEffect';
  }> {
    return modifiers.map((modifier) => ({
      name: modifier.constructor.name,
      priority: modifier.priority,
      tags: modifier.tags ? [...modifier.tags] : undefined,
      supportsGPU: modifier.supportsGPU,
      type: modifier instanceof Module ? 'module' : 'spatialEffect',
    }));
  }

  private _sampleGPUParticles(particles: Particle[]): Array<{
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

  private _debugVector(vector: THREE.Vector3): number[] {
    return [
      this._debugNumber(vector.x),
      this._debugNumber(vector.y),
      this._debugNumber(vector.z),
    ];
  }

  private _debugNumber(value: number): number {
    if (!Number.isFinite(value)) return value;
    return Number(value.toFixed(4));
  }

  private _prepareGPUTagRegistry(modules: Module[], spatialEffects: SpatialEffect[] = []): void {
    this._gpuTagRegistry.clear();
    this._gpuTagOverflow = false;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let root: ParticleSystem = this;
    while (root._subSystemParent) root = root._subSystemParent;

    const registerSystem = (system: ParticleSystem): void => {
      const systemModules = system === this
        ? modules
        : system.modules.flatMap((module) => module.withDependents());
      const systemSpatialEffects = system === this ? spatialEffects : system.spatialEffects;

      systemModules.forEach((module) => {
        module.tags?.forEach((tag) => this._registerGPUTag(tag));
      });
      systemSpatialEffects.forEach((spatialEffect) => {
        spatialEffect.tags?.forEach((tag) => this._registerGPUTag(tag));
      });
      system.emitters.forEach((emitter) => {
        emitter.tags?.forEach((tag) => this._registerGPUTag(tag));
      });
      system.renderers.forEach((renderer) => {
        renderer.tags?.forEach((tag) => this._registerGPUTag(tag));
      });
      system.subSystems.forEach((options, child) => {
        options.tags?.forEach(tag => this._registerGPUTag(tag));
        registerSystem(child);
      });
    };

    registerSystem(root);
  }

  private _registerGPUTag(tag: Tag): void {
    if (this._gpuTagRegistry.has(tag) || this._gpuTagOverflow) return;
    if (this._gpuTagRegistry.size >= 32) {
      this._gpuTagOverflow = true;
      return;
    }

    this._gpuTagRegistry.set(tag, this._gpuTagRegistry.size);
  }

  private _getParticleGPUTagMask(particle: Particle): number {
    return this._getGPUTagMask(particle.tags) ?? 0;
  }

  private _getGPUEmitterTagMasks(emitter: Emitter): number[] {
    return emitter.tags?.map((tag) => this._getGPUTagMask([tag]) ?? 0) ?? [];
  }

  private _getGPUTagMask(tags?: Tag[]): number | undefined {
    if (!tags) return undefined;

    let mask = 0;
    tags.forEach((tag) => {
      const index = this._gpuTagRegistry.get(tag);
      if (index === undefined) return;
      mask += 2 ** index;
    });

    return mask >>> 0;
  }

  private _getGPUTagsFromMask(mask: number): Tag[] | undefined {
    if (!mask) return undefined;
    const tags = Array.from(this._gpuTagRegistry.entries())
      .filter(([, index]) => (mask & (2 ** index)) !== 0)
      .map(([tag]) => tag);
    return tags.length > 0 ? tags : undefined;
  }

  private _usesGPUStableParticleSlots(): boolean {
    return this._isGPUProcessingActive
      || (this.gpuProcessing && isWebGPURenderer(this.sceneRenderer));
  }

  private _shouldRequestGPUReadback(): boolean {
    const rate = Math.max(0, ParticleSystem.GPU_READBACK_RATE);
    if (rate <= 0) return false;

    const interval = 1000 / rate;
    return performance.now() - this._lastGPUReadbackRequestTime >= interval;
  }

  private _hasGPUEventConsumers(): boolean {
    if (
      this._deathListeners.length > 0
      || this._spawnListeners.length > 0
      || this._collisionListeners.length > 0
    ) return true;

    for (const options of this.subSystems.values()) {
      if (options.emitOnDeath || options.emitOnSpawn || options.emitOnCollision ||
        eventNames(options.onEvent).length) return true;
    }

    return false;
  }

  private _hasGPUNativeSubSystemConsumers(): boolean {
    for (const [subSystem, options] of this.subSystems) {
      if (subSystem._canUpdateAsGPUSubSystem(this, options)) return true;
    }
    return false;
  }

  private _canUpdateAsGPUSubSystem(parent: ParticleSystem, options: SubSystemOptions): boolean {
    if (!parent || !options || !parent._gpuBuffers || !parent._isGPUProcessingActive) return false;
    if (!this.gpuProcessing || !isWebGPURenderer(this.sceneRenderer ?? parent.sceneRenderer)) return false;
    if (typeof options.shouldEmit === 'function') return false;
    if (!this.emitters.length) return false;

    return options.emitContinuous
      || options.emitOnDeath
      || options.emitOnSpawn
      || options.emitOnCollision
      || eventNames(options.onEvent).length > 0;
  }

  private _canHandleNativeGPUEvent(parent: ParticleSystem, options: SubSystemOptions, event: string): boolean {
    if (!this._canUpdateAsGPUSubSystem(parent, options)) return false;
    const gpuHandler = !Array.isArray(options.onEvent) && options.onEvent?.gpu?.[event];
    return !cpuEventHandler(options.onEvent, event) || !!gpuHandler;
  }

  private _needsCPUEventReadback(): boolean {
    if (this._deathListeners.length || this._spawnListeners.length || this._collisionListeners.length) return true;
    for (const [child, options] of this.subSystems) {
      for (const name of this._eventTypes.keys()) {
        if (this._subscribes(options, name) && !child._canHandleNativeGPUEvent(this, options, name)) return true;
      }
    }
    return false;
  }

  private _getSubSystemGPUOptionsSignature(options: SubSystemOptions): string {
    return [
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
      options.impulseAffectsScale,
      options.impulseAffectsSpeed,
      options.impulseAffectsLifetime,
      options.impulseAffectsMass,
      options.impulseAffectsAlignment,
      options.impulseThreshold,
      String(options.shouldEmit),
      options.tags?.map(tag => this._gpuTagRegistry.get(tag)).join(','),
      eventNames(options.onEvent).map(name => {
        const handler = !Array.isArray(options.onEvent) && options.onEvent?.gpu?.[name];
        return [
          name,
          this._subSystemParent?._eventTypes.get(name),
          handler ? this._getObjectSignature(handler) : '',
          !!cpuEventHandler(options.onEvent, name),
        ].join(':');
      }).join(','),
    ].join(':');
  }

  private _getInitialGPUBufferCapacity(): number {
    const estimatedParticles = this.emitters.reduce((total, emitter) => {
      const rate = this._getDynamicNumberMaximum(emitter.rate);
      const lifetime = this._getDynamicNumberMaximum(emitter.initialValues.lifetime ?? 1);
      const burstParticles = emitter.bursts.reduce(
        (burstTotal, burst) => burstTotal + this._getDynamicNumberMaximum(burst.count),
        0,
      );

      return total + rate * lifetime + burstParticles;
    }, 0);
    const required = Math.max(
      ParticleSystem.GPU_INITIAL_BUFFER_SIZE,
      this.particles.length,
      this._stagedBirths.length,
      Math.ceil(estimatedParticles),
      1,
    );
    return Math.min(nextPowerOfTwo(required), Math.max(this.maxParticles, 1));
  }

  private _getDynamicNumberMaximum(value: DynamicValue<number>, depth = 0): number {
    if (depth > 8) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, value) : 0;
    if (Array.isArray(value)) {
      return Math.max(...value.map((item) => this._getDynamicNumberMaximum(item, depth + 1)));
    }
    if (value instanceof Set) {
      return Math.max(0, ...Array.from(value, (item) => this._getDynamicNumberMaximum(item, depth + 1)));
    }
    if (typeof value === 'function') {
      const resolution = Math.max(2, Math.floor(ParticleSystem.GPU_DYNAMIC_VALUE_RESOLUTION));
      let maximum = 0;

      for (let index = 0; index < resolution; index += 1) {
        try {
          maximum = Math.max(
            maximum,
            this._getDynamicNumberMaximum(value(index / (resolution - 1)), depth + 1),
          );
        } catch {
          return maximum;
        }
      }

      return maximum;
    }

    return 0;
  }

  private _acquireGPUEventBuffer(renderer: WebGPURenderer): GPUEventBufferState {
    const capacity = Math.min(
      ParticleSystem.GPU_EVENT_BUFFER_CAPACITY,
      Math.max(32, this.maxParticles * 3),
    );
    if (!this._gpuEventBuffer || this._gpuEventBuffer.capacity !== nextPowerOfTwo(capacity)) {
      this._gpuResourceBuildCount += 1;
      this._gpuEventBuffer = new GPUEventBufferState(capacity);
    }

    this._gpuEventBuffer.initialize(renderer);
    return this._gpuEventBuffer;
  }

  private _acquireGPUCollisionEventBuffer(
    renderer: WebGPURenderer,
  ): GPUCollisionEventBufferState {
    const capacity = Math.max(this._gpuBuffers?.capacity ?? 1, 1);
    if (!this._gpuCollisionEventBuffer || this._gpuCollisionEventBuffer.capacity !== capacity) {
      this._gpuCollisionEventBuffer?.dispose(renderer);
      this._gpuResourceBuildCount += 1;
      this._gpuCollisionEventBuffer = new GPUCollisionEventBufferState(capacity);
    }

    this._gpuCollisionEventBuffer.initialize(renderer);
    return this._gpuCollisionEventBuffer;
  }

  private _acquireGPUAllocationBuffer(renderer: WebGPURenderer): GPUAllocationBufferState {
    const capacity = Math.max(this._gpuBuffers?.capacity ?? 1, 1);
    if (!this._gpuAllocationBuffer || this._gpuAllocationBuffer.capacity !== capacity) {
      this._gpuResourceBuildCount += 1;
      this._gpuAllocationBuffer = new GPUAllocationBufferState(capacity);
    }

    this._gpuAllocationBuffer.initialize(renderer);
    return this._gpuAllocationBuffer;
  }

  private _acquireGPUEmitterInstances(
    kind: 'standalone' | 'continuous' | 'event',
    capacity: number,
    emitters: Emitter[],
    renderer: WebGPURenderer,
  ): GPUEmitterInstanceBufferState {
    const requiredCapacity = Math.max(1, capacity);
    const maxBurstCount = emitters.reduce((max, emitter) => Math.max(max, emitter.bursts.length), 0);
    const requiredBurstWordCount = Math.max(1, Math.ceil(maxBurstCount / 32));
    const field = kind === 'standalone'
      ? '_gpuStandaloneEmitterInstances'
      : kind === 'continuous'
        ? '_gpuContinuousEmitterInstances'
        : '_gpuEventEmitterInstances';
    let instances = this[field];
    if (
      !instances
      || instances.capacity !== requiredCapacity
      || instances.burstWordCount !== requiredBurstWordCount
    ) {
      this._gpuResourceBuildCount += 1;
      instances = new GPUEmitterInstanceBufferState(requiredCapacity, maxBurstCount);
      this[field] = instances;
      this._gpuEmissionPrepareComputeCache?.nodes.forEach((node) => node.dispose?.());
      this._gpuEmissionPrepareComputeCache = undefined;
      this._gpuEmissionFinalizeComputeCache?.nodes.forEach((node) => node.dispose?.());
      this._gpuEmissionFinalizeComputeCache = undefined;
      this._gpuEmissionComputeCache?.nodes.forEach((node) => node.dispose?.());
      this._gpuEmissionComputeCache = undefined;
      this._gpuOldEmissionComputeCache?.nodes.forEach((node) => node.dispose?.());
      this._gpuOldEmissionComputeCache = undefined;
      this._gpuOldSelectionComputeCache?.nodes.forEach((node) => node.dispose?.());
      this._gpuOldSelectionComputeCache = undefined;
      this._gpuContinuousSubSystemComputeCache?.nodes.forEach((node) => node.dispose?.());
      this._gpuContinuousSubSystemComputeCache = undefined;
      this._gpuEventSubSystemComputeCache?.nodes.forEach((node) => node.dispose?.());
      this._gpuEventSubSystemComputeCache = undefined;
    }

    instances.initialize(renderer);
    return instances;
  }

  private _acquireGPUEmissionRuns(
    capacity: number,
    renderer: WebGPURenderer,
  ): GPUEmissionRunBufferState {
    const requiredCapacity = Math.max(1, capacity);
    if (!this._gpuEmissionRuns || this._gpuEmissionRuns.capacity !== requiredCapacity) {
      this._gpuResourceBuildCount += 1;
      this._gpuEmissionRuns = new GPUEmissionRunBufferState(requiredCapacity);
      this._gpuEventSubSystemComputeCache?.nodes.forEach((node) => node.dispose?.());
      this._gpuEventSubSystemComputeCache = undefined;
    }

    this._gpuEmissionRuns.initialize(renderer);
    return this._gpuEmissionRuns;
  }

  private _getGPUCullingModeCode(): number {
    return this.maxCullingMode === MaxCulling.Old ? 1 : 0;
  }

  private _scheduleGPUEventReadback(buffer: GPUEventBufferState, renderer: WebGPURenderer): void {
    if (!this._needsCPUEventReadback()) {
      this._gpuCompletedEventBatches.set(buffer.sequence, { sequence: buffer.sequence, events: [],
        rawEventCount: 0, overflowCount: 0, capacity: buffer.capacity });
      this._flushGPUEventBatches();
      return;
    }
    if (typeof (renderer as { getArrayBufferAsync?: unknown }).getArrayBufferAsync !== 'function') return;
    if (!renderer.backend) return;

    const sequence = buffer.sequence;
    const lifecycleGeneration = this._gpuLifecycleGeneration;
    const readback = buffer.readback(
      renderer,
      (slot, generation) => this._getGPUParticleIdentity(slot, generation),
    );
    this._gpuEventReadbacksPending += 1;
    this._gpuEventReadbackCount += 1;
    void (async () => {
      try {
        const batch = await readback;
        if (lifecycleGeneration !== this._gpuLifecycleGeneration) return;
        batch.events.forEach((event) => {
          event.particle.tags = this._getGPUTagsFromMask(event.tagMask ?? 0);
        });

        this._gpuCompletedEventBatches.set(batch.sequence, batch);
        this._flushGPUEventBatches();
      } catch (error) {
        if (lifecycleGeneration !== this._gpuLifecycleGeneration) return;
        this._logGPUDebug('event readback failed', {
          sequence,
          error,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        this._gpuCompletedEventBatches.set(sequence, {
          sequence,
          events: [],
          rawEventCount: 0,
          capacity: buffer.capacity,
          overflowCount: 1,
        });
        this._flushGPUEventBatches();
      } finally {
        if (lifecycleGeneration === this._gpuLifecycleGeneration) {
          this._gpuEventReadbacksPending = Math.max(0, this._gpuEventReadbacksPending - 1);
        }
      }
    })();
  }

  private _flushGPUEventBatches(): void {
    while (this._gpuCompletedEventBatches.has(this._gpuNextEventDispatchSequence)) {
      const batch = this._gpuCompletedEventBatches.get(this._gpuNextEventDispatchSequence)!;
      this._gpuCompletedEventBatches.delete(this._gpuNextEventDispatchSequence);
      this._gpuNextEventDispatchSequence += 1;

      if (batch.overflowCount > 0 || batch.rawEventCount > batch.capacity) {
        this._gpuEventOverflowCount += Math.max(batch.overflowCount, batch.rawEventCount - batch.capacity);
        this._logGPUDebug('event buffer overflow', {
          sequence: batch.sequence,
          rawEventCount: batch.rawEventCount,
          capacity: batch.capacity,
          overflowCount: batch.overflowCount,
        });
      }

      batch.events.forEach((event) => {
        if (event.type === GPUEventType.Death) {
          this._dispatchGPUDeathEvent(event.slot, event.generation, event.particle);
        } else if (event.type === GPUEventType.Spawn) {
          this._dispatchGPUSpawnEvent(event.particle);
        } else if (event.type === GPUEventType.Collision) {
          if (event.collision) this._dispatchGPUCollisionEvent(event.particle, event.collision);
        } else {
          const name = Array.from(this._eventTypes).find(([, id]) => id === event.type)?.[0];
          if (name) this._dispatchSourceEvent(event.particle, name, event.data, true);
        }
      });
    }
  }

  private _dispatchGPUDeathEvent(slot: number, generation: number, particle: Particle): void {
    const key = this._getGPUParticleSlotKey(slot, generation);
    if (this._gpuDeliveredDeathEvents.has(key)) return;

    this._gpuDeliveredDeathEvents.add(key);

    const current = this.particles[slot];
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

    this._dispatchParticleDeath(particle, true);
  }

  /**
   * Reads a bounded selection of active GPU particles asynchronously.
   *
   * Request only the fields the caller consumes. The bounded readback pool can return an empty
   * array while busy, and results may trail the current simulation frame.
   */
  public async selectiveReadback(
    limit = Number.POSITIVE_INFINITY,
    fields?: readonly GPUParticleReadbackField[],
  ): Promise<GPUSelectiveReadbackResult[]> {
    return this._readbackGPUParticles(this._createReadbackRequests(limit, fields));
  }

  private async _readbackGPUParticles(
    requests: GPUSelectiveReadbackRequest[],
  ): Promise<GPUSelectiveReadbackResult[]> {
    if (!this._gpuBuffers || requests.length === 0) return [];

    const renderer = this.sceneRenderer;
    if (!isWebGPURenderer(renderer) || typeof renderer.getArrayBufferAsync !== 'function') {
      throw new Error('Selective GPU particle readback requires a WebGPU renderer with async buffer readback.');
    }

    let slot = this._gpuSelectiveReadbacks.find((candidate) => (
      !candidate.pending && candidate.state.capacity >= requests.length
    ));
    if (!slot) {
      const reusable = this._gpuSelectiveReadbacks.find((candidate) => !candidate.pending);
      if (reusable) {
        reusable.state = new GPUSelectiveReadbackState(Math.max(1, requests.length));
        slot = reusable;
      } else if (this._gpuSelectiveReadbacks.length < ParticleSystem.GPU_SELECTIVE_READBACK_POOL_SIZE) {
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
      results.forEach((result) => {
        result.particle.setEventOwner(this);
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
        lifecycleGeneration !== this._gpuLifecycleGeneration
        || this._destroyed
        || (error as { name?: unknown })?.name === 'AbortError'
      ) return [];
      throw error;
    } finally {
      slot.pending = false;
    }
  }

  private _createReadbackRequests(
    limit = Number.POSITIVE_INFINITY,
    fields?: readonly GPUParticleReadbackField[],
  ): GPUSelectiveReadbackRequest[] {
    if (!this._gpuBuffers) return [];

    const max = Math.min(
      this._gpuBuffers.count,
      Math.max(0, Math.floor(limit)),
    );
    const requests: GPUSelectiveReadbackRequest[] = [];

    for (let slot = 0; slot < max; slot += 1) {
      const generation = this._gpuParticleSlotGenerations[slot] ?? 0;
      const gpuNativeSlot = this._shouldExecuteEmittersOnGPU() && generation <= 0;
      if (generation <= 0 && !gpuNativeSlot) continue;

      requests.push({
        slot,
        generation: gpuNativeSlot ? 0 : generation,
        fields,
        identity: gpuNativeSlot
          ? undefined
          : this._getGPUParticleIdentity(slot, generation) ?? this.particles[slot],
      });
    }

    return requests;
  }

  private _getGPUParticleSlotGeneration(particle: Particle, index: number): number {
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

  private _getGPUParticleIdentity(slot: number, generation: number): Particle | undefined {
    return this._gpuParticleSlotIdentities.get(this._getGPUParticleSlotKey(slot, generation))?.particle;
  }

  private _getGPUParticleSlotKey(slot: number, generation: number): string {
    return `${slot}:${generation}`;
  }

  private _uploadDirtyGPUParticleSlots(buffer: GPUParticleBufferState): void {
    this._gpuDirtyParticleSlots.forEach((index) => {
      const particle = this.particles[index];
      if (!particle) return;

      buffer.uploadIndex(
        index,
        particle,
        (value) => this._getParticleGPUTagMask(value),
        (value, slot) => this._getGPUParticleSlotGeneration(value, slot),
      );
    });
  }

  private _markExpiredGPUParticleSlots(): void {
    this.particles.forEach((particle, index) => {
      if (!particle.alive) return;
      if (particle.realtime <= particle.lifetime * 1000) return;

      particle.alive = false;
      this._gpuDirtyParticleSlots.add(index);
      this._notifyParticleDeath(particle);
    });
  }

  private _applyGPUReadbackDeaths(particles: Particle[], wasAlive: boolean[]): void {
    particles.forEach((particle, index) => {
      if (particle.alive && particle.realtime > particle.lifetime * 1000) {
        particle.alive = false;
        this._gpuDirtyParticleSlots.add(index);
      }

      if (wasAlive[index] && !particle.alive && particle.lodPriority < this.quality) {
        this._gpuDirtyParticleSlots.add(index);
      }
    });
  }

  private _notifyParticleDeath(particle: Particle): void {
    this._dispatchParticleDeath(particle);
  }

  private _dispatchParticleDeath(particle: Particle, fromGPUEvent = false): void {
    this._notifyDeath(particle, fromGPUEvent);

    this.subSystems.forEach((options, subSystem) => {
      if (fromGPUEvent && subSystem._canUpdateAsGPUSubSystem(this, options)) return;
      subSystem.emitters.forEach((emitter) => emitter.clearContext(particle.id));
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

    const accepts = (spatialEffect: SpatialEffect) => (
      spatialEffect.modifiesParticles
      && (!this.spatialEffectFilter || this.spatialEffectFilter(spatialEffect))
      && this._spatialEffectOverlapsTravelBounds(spatialEffect)
    );
    const spatialEffects = this.spatialEffects
      .filter(accepts);

    this.scene?.traverse((object) => {
      if (
        object instanceof SpatialEffect
        && accepts(object)
        && !spatialEffects.includes(object)
      ) spatialEffects.push(object);
    });

    return spatialEffects;
  }

  private _spatialEffectOverlapsTravelBounds(effect: SpatialEffect): boolean {
    if (
      !this.spatialEffectBoundsFiltering
      || !effect.usesBuiltInTest
      || effect.inverted
    ) return true;

    const hasParticles = this.particles.some((particle) => particle.alive)
      || (this._gpuAllocationDiagnostics?.activeCount ?? 0) > 0;
    if (!hasParticles || this.boundingBox.isEmpty()) return true;

    let maxVelocity = this._isGPUProcessingActive
      ? (this._gpuAllocationDiagnostics?.maxVelocity ?? 0)
      : 0;
    if (!this._isGPUProcessingActive) {
      this.particles.forEach((particle) => {
        if (!particle.alive) return;
        maxVelocity = Math.max(
          maxVelocity,
          particle.velocity.length() * Math.abs(particle.speed),
        );
      });
    }
    const gpuMirrorInterval = ParticleSystem.GPU_READBACK_RATE > 0
      ? 1 / ParticleSystem.GPU_READBACK_RATE
      : 0;
    const travelTime = Math.max(this.deltaTime, this._isGPUProcessingActive ? gpuMirrorInterval : 0);
    this._spatialEffectTravelBounds.copy(this.boundingBox)
      .expandByScalar(maxVelocity * travelTime);

    const effectBounds = effect.getWorldBounds();
    if (this.simulationSpace === SimulationSpace.Local) {
      this.updateWorldMatrix(true, false);
      this._spatialEffectBoundsInverse.copy(this.matrixWorld).invert();
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

      // Apply gravity
      const gravityScale = this.deltaTime * evaluateDynamicNumber(this.gravityModifier, p.time, p.id);
      p.velocity.addScaledVector(
        this.gravity,
        gravityScale,
      );

      // Update time
      p.realtime += this.deltaTime * 1000;
      p.time = (p.realtime / 1000) / p.lifetime;

      // Update transform
      p.position.addScaledVector(p.velocity, this.deltaTime * p.speed);
      p.rotation.addScaledVector(p.angularVelocity, this.deltaTime * p.speed);
      p.scale.addScaledVector(p.scalarVelocity, this.deltaTime * p.speed);

      // Update velocities
      p.velocity.addScaledVector(p.acceleration, this.deltaTime * p.speed);
      p.angularVelocity.addScaledVector(p.angularAcceleration, this.deltaTime * p.speed);
      p.scalarVelocity.addScaledVector(p.scalarAcceleration, this.deltaTime * p.speed);

      // Kill old particles
      if (p.realtime > p.lifetime * 1000) {
        p.alive = false;
        this._notifyParticleDeath(p);
        continue;
      }

      if (transientBase && transientFrame) {
        p.cacheValues(this._getAdvancedPermanentValues(p, transientBase, transientFrame, gravityScale));
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
      this._isGPUProcessingActive
      && this._gpuCPUMirrorStale
      && this._gpuAllocationDiagnostics?.bounds
    ) {
      this.boundingBox.copy(this._gpuAllocationDiagnostics.bounds);
      return;
    }

    this.boundingBox.makeEmpty();

    this.particles.forEach((particle) => {
      const particleRadius = Math.max(
        Math.abs(particle.scale.x),
        Math.abs(particle.scale.y),
        Math.abs(particle.scale.z),
        Number.EPSILON,
      );

      this._particleBoundsMin
        .copy(particle.position)
        .addScalar(-particleRadius);
      this._particleBoundsMax
        .copy(particle.position)
        .addScalar(particleRadius);
      this.boundingBox.expandByPoint(this._particleBoundsMin);
      this.boundingBox.expandByPoint(this._particleBoundsMax);
    });

    if (this.boundingBox.isEmpty()) {
      this.boundingBox.setFromCenterAndSize(
        this._particleBoundsMin.set(0, 0, 0),
        this._particleBoundsSize,
      );
    }
  }

  private _getAdvancedPermanentValues(
    particle: Particle,
    base: ParticleCachedValues,
    frame: ParticleCachedValues,
    gravityScale: number,
  ): ParticleCachedValues {
    const next = particle.snapshot();
    const frameVelocity = frame.velocity.clone().addScaledVector(this.gravity, gravityScale);
    const baseVelocity = base.velocity.clone().addScaledVector(this.gravity, gravityScale);

    next.lifetime = base.lifetime;
    next.position.copy(base.position).addScaledVector(frameVelocity, this.deltaTime * frame.speed);
    next.orbitCenter.copy(base.orbitCenter);
    next.rotation.copy(base.rotation).addScaledVector(frame.angularVelocity, this.deltaTime * frame.speed);
    next.scale.copy(base.scale).addScaledVector(frame.scalarVelocity, this.deltaTime * frame.speed);
    next.velocity.copy(baseVelocity).addScaledVector(base.acceleration, this.deltaTime * base.speed);
    next.angularVelocity
      .copy(base.angularVelocity)
      .addScaledVector(base.angularAcceleration, this.deltaTime * base.speed);
    next.scalarVelocity.copy(base.scalarVelocity).addScaledVector(base.scalarAcceleration, this.deltaTime * base.speed);
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
    if (this._isGPUProcessingActive && this._gpuBuffers && !this._gpuContinuousSourcesReadbackPending
      && Array.from(this.subSystems).some(([child, options]) => options.emitContinuous &&
        !child._canUpdateAsGPUSubSystem(this, options))) {
      this._readGPUContinuousSources();
    }
    for (const source of this._emissionSources.values()) {
      source.realtime += this.deltaTime * 1000;
      source.time = source.realtime / (Math.max(this.duration, Number.EPSILON) * 1000);
    }
    this.subSystems.forEach((options, subSystem) => {
      if (subSystem._canUpdateAsGPUSubSystem(this, options)) {
        subSystem._updateAsGPUSubSystem(this, options, this.deltaTime);
      } else {
        subSystem._updateAsSubSystem([
          ...(this._isGPUProcessingActive ? this._gpuContinuousSourceSnapshots : this.particles),
          ...this._emissionSources.values(),
        ], options, this.deltaTime);
      }
    });

    if (
      this._gpuFrameEventBuffer
      && isWebGPURenderer(this.sceneRenderer)
      && this._hasGPUNativeSubSystemConsumers()
    ) {
      this._scheduleGPUEventReadback(this._gpuFrameEventBuffer, this.sceneRenderer);
    }
  }

  private _readGPUContinuousSources(): void {
    const lifecycle = this._gpuLifecycleGeneration;
    this._gpuContinuousSourcesReadbackPending = true;
    const requests = Array.from({ length: this._gpuBuffers!.count }, (_, slot) => ({ slot, generation: 0 }));
    void this._readbackGPUParticles(requests).then(results => {
      if (lifecycle !== this._gpuLifecycleGeneration) return;
      if (!results.length && requests.length) return; // Keep contexts while the bounded pool is busy.
      const next = results.filter(result => result.valid).map(result => {
        const identity = this._getGPUParticleIdentity(result.slot, result.generation);
        if (identity) result.particle.id = identity.id;
        return result.particle;
      });
      const live = new Set(next.map(p => p.id));
      for (const old of this._gpuContinuousSourceSnapshots) {
        if (!live.has(old.id)) this.subSystems.forEach((options, child) => {
          if (!child._canUpdateAsGPUSubSystem(this, options)) child.emitters.forEach(emitter =>
            emitter.clearContext(old.id));
        });
      }
      this._gpuContinuousSourceSnapshots = next;
    }).catch(error => { console.warn('RZMPS: continuous subsystem source readback failed.', error); })
      .finally(() => { if (lifecycle === this._gpuLifecycleGeneration) this._gpuContinuousSourcesReadbackPending =
        false; });
  }

  private _updateAsGPUSubSystem(
    parent: ParticleSystem,
    options: SubSystemOptions,
    parentDeltaTime: number,
  ): void {
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
    this.syncRendererParents();
    this.deltaTime = nextDeltaTime;
    if (options.emitContinuous) this._prewarm();
    if (this._playing && options.emitContinuous) this._updateSystemTime();

    this._emitContinuousSources(parent._emissionSources.values(), options);
    if (this._playing) this._updateEmissionRuns(options);
    this._gpuSubSystemFrameInput = { parent, options };
    this._processParticles();
    this._gpuSubSystemFrameInput = undefined;
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
    this.syncRendererParents();
    this.deltaTime = nextDeltaTime;
    if (options.emitContinuous) this._prewarm();
    if (this._playing && options.emitContinuous) this._updateSystemTime();

    this._emitContinuousSources(parentParticles, options);

    if (this._playing) this._updateEmissionRuns(options);
    this._cpuSubSystemFrameActive = true;
    try {
      this._processParticles();
    } finally {
      this._cpuSubSystemFrameActive = false;
    }
    this._updateSubSystems();
    if (options.emitContinuous) this._handleEndBehavior();
  }

  private _sourceContext(source: SubSystemSource, options: SubSystemOptions): Partial<EmissionContext> {
    const finiteLifetime = Number.isFinite(source.lifetime);
    const lifetime = finiteLifetime ? options.inheritLifetime : 0;
    return {
      key: source.id,
      transform: this._particleEmissionTransform(source, options.inheritScale),
      position: source.position.clone(),
      time: lifetime > 0 ? source.time * lifetime : undefined,
      elapsedTime: source instanceof EmissionSource ? source.realtime / 1000 : undefined,
      duration: lifetime > 0 ? THREE.MathUtils.lerp(this.duration, source.lifetime, lifetime) : undefined,
      looping: lifetime > 0 ? false : this.looping,
      color: new THREE.Color(1, 1, 1).lerp(source.color, Math.max(0, options.inheritColor)),
      alpha: THREE.MathUtils.lerp(1, source.alpha, Math.max(0, options.inheritAlpha)),
      mass: THREE.MathUtils.lerp(1, source.mass, Math.max(0, options.inheritMass)),
      velocity: source.velocity.clone().multiplyScalar(Math.max(0, options.inheritVelocity)),
      tags: source.tags?.slice(),
    };
  }

  private _emitContinuousSources(sources: Iterable<SubSystemSource>, options: SubSystemOptions): void {
    if (!this._playing || !options.emitContinuous) return;
    for (const source of sources) {
      if (!this._canEmitForParticle(source, options)) continue;
      const context = this._sourceContext(source, options);
      this.emitters.forEach(emitter => this._emitContext(emitter, context));
    }
  }

  private _emitContext(emitter: Emitter, context: Partial<EmissionContext>): void {
    // CPU event callbacks and registered origins share existing emitter context state.
    // GPU simulation receives one batch of births at the frame boundary and allocates
    // their actual slots on the GPU, so a stale CPU mirror can never overwrite a live slot.
    const stage = this._canUpdateAsGPUSubSystem(this._subSystemParent!, this._subSystemParent?.subSystems.get(this)!);
    const particles = emitter.update(stage ? this._stagedBirths : this.particles, context, this);
    if (!stage) particles.forEach(p => this._notifySpawn(p));
  }

  private _updateEmissionRuns(options: SubSystemOptions): void {
    for (let i = this._emissionRuns.length - 1; i >= 0; i -= 1) {
      const run = this._emissionRuns[i];

      run.realtime += this.deltaTime;

      let finished = true;

      this.emitters.forEach((emitter) => {
        const duration = run.duration ?? this.duration;

        const elapsed = run.realtime;
        const startTime = 0;
        const time = startTime + (elapsed / duration);

        // Ignore looping emitters
        if (time < 1) {
          finished = false;

          this._emitContext(emitter, {
            key: run.id,
            transform: run.transform,
            position: run.particle.position,
            time,
            duration,
            elapsedTime: elapsed,
            looping: false,
            color: options.inheritColor > 0
              ? this._particleEmissionColor.set(1, 1, 1).lerp(run.particle.color, options.inheritColor)
              : undefined,
            alpha: options.inheritAlpha > 0
              ? THREE.MathUtils.lerp(1, run.particle.alpha, options.inheritAlpha)
              : undefined,
            mass: this._getEmissionRunMass(run, options),
            velocity: options.inheritVelocity > 0
              ? this._particleEmissionVelocity.copy(run.particle.velocity).multiplyScalar(options.inheritVelocity)
              : undefined,
            scale: this._getImpulseEffect(run.collision, options.impulseAffectsScale),
            velocityScale: this._getImpulseEffect(run.collision, options.impulseAffectsSpeed),
            tags: run.particle.tags,
            ...run.context,
          });
        } else {
          emitter.clearContext(run.id);
        }
      });

      if (finished) {
        this._emissionRuns.splice(i, 1);
      }
    }
  }

  private _canEmitForParticle(particle: SubSystemSource, options: SubSystemOptions): boolean {
    if (options.tags && !tagsIntersect(particle.tags ?? [], options.tags)) return false;
    if (!particleRatio(particle, options.ratio ?? 1)) return false;
    return typeof options.shouldEmit === 'function'
      ? options.shouldEmit(particle)
      : options.shouldEmit;
  }

  private _startEmissionRunAtParticle(
    particle: SubSystemSource,
    options: SubSystemOptions,
    collision?: CollisionHit,
    handler?: import('./Events').CPUEventHandler,
    data?: unknown,
  ): void {
    if (collision) collision = { ...collision, point: collision.point.clone(),
      normal: collision.normal.clone(), impulse: collision.impulse.clone() };
    const now = Date.now();

    this._playing = true;
    this._paused = false;
    this._ended = false;
    this.lastFrame = now;

    const impulse = collision?.impulse;
    const transform = this._particleEmissionTransform(
      particle,
      options.inheritScale,
      options.impulseAffectsAlignment ? impulse : undefined,
    );
    const baseDuration = THREE.MathUtils.lerp(
      this.duration,
      Number.isFinite(particle.lifetime) ? particle.lifetime : this.duration,
      options.inheritLifetime,
    );
    const impulseDuration = collision && options.impulseAffectsLifetime > 0
      ? this._getImpulseEffect(collision, options.impulseAffectsLifetime)
      : 0;
    const duration = baseDuration + impulseDuration;
    const baseContext = {
      ...this._sourceContext(particle, options), transform, scale: this._getImpulseEffect(collision,
        options.impulseAffectsScale),
      velocityScale: this._getImpulseEffect(collision, options.impulseAffectsSpeed),
      duration, time: 0, elapsedTime: 0, looping: false, distortionStrength: 1,
      tags: particle.tags?.slice() ?? [],
      mass: (this._sourceContext(particle,
        options).mass ?? 1) * (options.impulseAffectsMass > 0 ? this._getImpulseEffect(collision,
        options.impulseAffectsMass) : 1),
    } as EmissionContext;
    const overrides = handler?.(data, particle, baseContext);
    const eventContext = handler ? { ...baseContext, ...overrides } : undefined;
    if (eventContext) {
      eventContext.transform = eventContext.transform.clone();
      eventContext.position = eventContext.position.clone();
      eventContext.velocity = eventContext.velocity.clone();
      eventContext.color = eventContext.color.clone();
      eventContext.tags = eventContext.tags?.slice() ?? [];
      // Timing and identity belong to the run, while callback values are frozen now.
      delete (eventContext as Partial<EmissionContext>).key;
      delete (eventContext as Partial<EmissionContext>).time;
      delete (eventContext as Partial<EmissionContext>).elapsedTime;
      if (overrides?.position && !overrides.transform) eventContext.transform.setPosition(overrides.position);
      if (overrides?.transform && !overrides.position) eventContext.position.setFromMatrixPosition(overrides.transform);
    }
    this._emissionRuns.push({
      id: `event_${this._nextEmissionRunId++}`,
      transform,
      startTime: now,
      realtime: 0,

      duration: eventContext?.duration ?? duration,
      context: eventContext,

      // If a collision was passed in, pass it to the context
      collision,

      // Pass particle info -- clone so reference doesn't get destroyed
      particle: {
        position: particle.position.clone(),
        rotation: particle.rotation.clone(),
        scale: particle.scale.clone(),
        color: particle.color.clone(),
        tags: particle.tags ? [...particle.tags] : undefined,
        alpha: particle.alpha,
        lifetime: particle.lifetime,
        mass: particle.mass,
        velocity: particle.velocity.clone(),
      },
    });
  }

  private _particleEmissionTransform(
    particle: SubSystemSource,
    inheritScale: number = 0,
    alignUpTo?: THREE.Vector3,
  ): THREE.Matrix4 {
    const quaternion = alignUpTo && alignUpTo.lengthSq() > 0
      ? this._particleEmissionQuaternion.setFromUnitVectors(
        this._particleEmissionUnitY,
        this._particleEmissionAlignUp.copy(alignUpTo).normalize(),
      )
      : this._particleEmissionQuaternion.setFromEuler(this._particleEmissionEuler.set(
        particle.rotation.x,
        particle.rotation.y,
        particle.rotation.z,
      ));

    return new THREE.Matrix4().compose(
      particle.position,
      quaternion,
      inheritScale > 0
        ? this._particleEmissionScale.copy(this._particleEmissionUnitScale).lerp(particle.scale, inheritScale)
        : this._particleEmissionUnitScale,
    );
  }

  // eslint-disable-next-line class-methods-use-this
  private _getImpulseEffect(collision: CollisionHit | undefined, effect: number): number {
    return Math.pow(Math.max(0, collision?.impulse.length() ?? 1), effect);
  }

  private _getEmissionRunMass(
    run: SubSystemEmissionRun,
    options: SubSystemOptions,
  ): number | undefined {
    const inheritedMass = options.inheritMass > 0
      ? THREE.MathUtils.lerp(1, run.particle.mass, options.inheritMass)
      : undefined;
    const impulseMass = options.impulseAffectsMass > 0
      ? this._getImpulseEffect(run.collision, options.impulseAffectsMass)
      : undefined;

    if (inheritedMass === undefined) return impulseMass;
    if (impulseMass === undefined) return inheritedMass;

    return inheritedMass * impulseMass;
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

    this.emitters.forEach((emitter) => emitter.reset());
    this._gpuStandaloneEmitterInstances?.reset();
    this._gpuContinuousEmitterInstances?.reset();
    this._gpuEventEmitterInstances?.reset();
    this._gpuEmissionRuns?.reset();

    this._emissionRuns.forEach((run) => {
      this.emitters.forEach((emitter) => emitter.clearContext(run.id));
    });

    this._emissionRuns.length = 0;

    this.subSystems.forEach((_options, subSystem) => {
      subSystem.start();
    });

    if (children) this._iterateChildren((child) => child.start(false));

    this._prewarm();
  }

  /** Freezes emission and simulation while playing; propagates to subsystems and optionally child systems. */
  public pause(children: boolean = true): void {
    if (!this._playing || this._paused) return;
    this._paused = true;

    this.subSystems.forEach((_options, subSystem) => {
      subSystem.pause();
    });

    if (children) this._iterateChildren((child) => child.pause(false));
  }

  /** Stops emission and resets prewarm state. clearParticles chooses whether to remove them immediately. */
  public stop(clearParticles: boolean, children: boolean = true): void {
    this._playing = false;
    this._paused = false;
    this._ended = true;
    this._prewarmed = false
    this._resetEmitterContextVelocity();

    this.subSystems.forEach((_options, subSystem) => {
      // Clear the complete subsystem tree once through this system below.
      subSystem.stop(false);
    });

    if (children) this._iterateChildren((child) => child.stop(clearParticles, false));

    this._emissionRuns.forEach((run) => {
      this.emitters.forEach((emitter) => {
        emitter.clearContext(run.id);
      });
    });

    this._emissionRuns.length = 0;

    // Registered subsystems are part of this system's particle state, even when
    // ordinary Object3D child propagation is disabled.
    if (clearParticles) this.clearParticles(false);
  }

  /** Stop, clear all CPU/GPU state and timing, then begin a fresh run. */
  public reset(children: boolean = true): void {
    this.renderers.forEach((renderer) => renderer.reset());
    this.stop(true, false);
    this.start(false);

    if (children) this._iterateChildren((child) => child.reset(false));
  }

  /** Clears particles and renderer contents; optionally includes independent child systems. */
  public clearParticles(children: boolean = true): void {
    const gpuRenderer = isWebGPURenderer(this.sceneRenderer) ? this.sceneRenderer : undefined;
    this._gpuLifecycleGeneration += 1;
    this.particles.length = 0;
    this._particleSpacing.clear();
    this.particleOctree = undefined;
    this._particleOctreeToken = undefined;
    if (this._gpuParticleSpacing) {
      this._gpuParticleSpacing.node.dispose();
      destroyGPUStorageAttribute(gpuRenderer, this._gpuParticleSpacing.attribute);
      this._gpuParticleSpacing = undefined;
    }
    this._isGPUProcessingActive = false;
    this._processingMode = undefined;
    this._gpuBuffers?.dispose(gpuRenderer);
    this._gpuRenderOutputBuffers?.dispose(gpuRenderer);
    this._gpuBuffers = undefined;
    this._gpuRenderOutputBuffers = undefined;
    this._gpuSpatialRegistry?.dispose(gpuRenderer);
    this._gpuSpatialRegistry = undefined;
    this._gpuSelectiveReadbacks.forEach((slot) => slot.state.dispose(gpuRenderer));
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
    this._stagedBirths.length = 0;
    this._pendingGPUEvents.length = 0;
    this._gpuContinuousSourcesReadbackPending = false;
    this._gpuContinuousSourceSnapshots = [];
    this._stagedBirthBuffers?.dispose(gpuRenderer);
    this._stagedBirthBuffers = undefined;
    this._stagedBirthCompute?.nodes.forEach(node => node.dispose());
    this._stagedBirthCompute = undefined;
    this._gpuFrameEventBuffer = undefined;
    this._gpuEventBuffer?.dispose(gpuRenderer);
    this._gpuEventBuffer = undefined;
    this._gpuCollisionEventBuffer?.dispose(gpuRenderer);
    this._gpuCollisionEventBuffer = undefined;
    this._gpuEventReadbacksPending = 0;
    this._gpuEventReadbackCount = 0;
    this._gpuEventFrameSequence = 0;
    this._gpuNextEventDispatchSequence = 1;
    this._gpuCompletedEventBatches.clear();
    this._gpuDeliveredDeathEvents.clear();
    this._gpuParticleSlotIds.length = 0;
    this._gpuParticleSlotGenerations.length = 0;
    this._gpuParticleSlotIdentities.clear();
    this._gpuEventOverflowCount = 0;
    this._disposeGPUComputeCaches();
    this._gpuReadbackPending = false;
    this._gpuReadbacksInFlight = 0;
    this._gpuReadbackSequence = 0;
    this._latestAppliedGPUReadbackSequence = 0;
    this._lastGPUReadbackRequestTime = Number.NEGATIVE_INFINITY;
    this._gpuCPUMirrorStale = false;
    this._gpuDirtyParticleSlots.clear();
    this._prewarmed = false;

    this.renderers.forEach((renderer) => {
      renderer.update(this.particles, this);
      renderer.clear();
    });

    this.subSystems.forEach((_options, subSystem) => {
      subSystem.clearParticles();
    });

    if (children) this._iterateChildren((child) => child.clearParticles(false));
  }

  /** Permanently destroys this system and renderer resources; later update or advancement calls do nothing. */
  public destroy(children: boolean = true): void {
    if (this._destroyed) return;

    for (const id of this._emissionSources.keys()) this.unregisterEmissionSource(id);
    this._destroyed = true;
    this.stop(true, children);

    this.subSystems.forEach((_options, subSystem) => {
      subSystem.destroy();
    });

    if (children) this._iterateChildren((child) => child.destroy(false));

    this.renderers.forEach((renderer) => {
      renderer.reset();
      renderer.destroy();
    });
    const gpuRenderer = isWebGPURenderer(this.sceneRenderer) ? this.sceneRenderer : undefined;
    this._particleSpatialGrids.forEach((grid) => grid.dispose(gpuRenderer));
    this._particleSpatialGrids.clear();
    this._explicitParticleSpatialGrids.clear();

    this.removeFromParent();
    this.cleanup();
    this.dispatchEvent({ type: 'destroyed' } as unknown as Parameters<typeof this.dispatchEvent>[0]);
  }

  /*
    * ACCESSING
  */

  /** Adds a particle while preserving stable GPU slots and the configured capacity policy. */
  public addParticle(particle: Particle, particles: Particle[] = this.particles): boolean {
    particle.setEventOwner(this);
    if (this.maxParticles <= 0) return false;

    if (!this._usesGPUStableParticleSlots() || particles !== this.particles) {
      particles.push(particle);
      return true;
    }

    const deadIndex = particles.findIndex((candidate) => !candidate.alive);
    if (deadIndex !== -1) {
      particles[deadIndex] = particle;
      this._gpuDirtyParticleSlots.add(deadIndex);
      return true;
    }

    if (particles.length >= this.maxParticles) {
      if (this.maxCullingMode === MaxCulling.New) return false;

      if (particles[0]?.alive) {
        particles[0].alive = false;
        this._notifyParticleDeath(particles[0]);
      }
      particles[0] = particle;
      this._gpuDirtyParticleSlots.add(0);
      return true;
    }

    particles.push(particle);
    this._gpuDirtyParticleSlots.add(particles.length - 1);
    return true;
  }

  /** Attaches an emitter and runs its setup hook. */
  public addEmitter(emitter: Emitter): this {
    this.emitters.push(emitter);
    emitter.setup(this);

    return this;
  }

  /** Removes an emitter from emission and clears its association with the system. */
  public removeEmitter(emitter: Emitter): this {
    const index = this.emitters.indexOf(emitter);

    if (index !== -1) {
      this.emitters.splice(index, 1);
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

  /** Registers a persistent CPU-managed subsystem emission origin. */
  public registerEmissionSource(data: EmissionSourceData): EmissionSource {
    if (this._destroyed) throw new Error('Cannot register an emission source on a destroyed system.');
    const source = new EmissionSource(this, data);
    this._emissionSources.set(source.id, source);
    this._dispatchSourceEvent(source, 'spawn');
    return source;
  }

  /** Updates CPU attributes only; repeated updates coalesce at the next frame. */
  public updateSource(id: string, changes: Partial<EmissionSourceData>): void {
    this._emissionSources.get(id)?.apply(changes);
  }

  /** Dispatches death once and releases continuous context state; event runs keep their snapshots. */
  public unregisterEmissionSource(id: string): void {
    const source = this._emissionSources.get(id);
    if (!source) return;
    this._emissionSources.delete(id);
    source.alive = false;
    this._dispatchSourceEvent(source, 'death');
    this.subSystems.forEach((_options, child) => child.emitters.forEach(emitter => emitter.clearContext(id)));
  }

  /** Targets either a registered source or a live simulated particle by its stable ID. */
  public emitEvent(id: string, event: string, data?: unknown): void {
    const registered = this._emissionSources.get(id);
    if (registered) { this._dispatchSourceEvent(registered, event, data); return; }
    const index = this.particles.findIndex(p => p.id === id && p.alive);
    if (!this._isGPUProcessingActive) {
      if (index >= 0) this._dispatchSourceEvent(this.particles[index], event, data);
      return;
    }
    const gpuID = /^gpu:(\d+):(\d+)$/.exec(id);
    const slot = gpuID ? Number(gpuID[1]) : index;
    const generation = gpuID ? Number(gpuID[2]) : this._gpuParticleSlotGenerations[index];
    if (this._gpuBuffers && slot >= 0 && slot < this._gpuBuffers.capacity && generation > 0) {
      this._pendingGPUEvents.push({ slot, generation, event, data });
    }
  }

  private _flushTargetedGPUEvents(): void {
    if (!this._pendingGPUEvents.length) return;
    const events = this._pendingGPUEvents.splice(0);
    const requests = Array.from(new Map(events.map(e => [`${e.slot}:${e.generation}`,
      { slot: e.slot, generation: e.generation, identity: this._getGPUParticleIdentity(e.slot,
        e.generation) }])).values());
    const lifecycle = this._gpuLifecycleGeneration;
    void this._readbackGPUParticles(requests).then(results => {
      if (lifecycle !== this._gpuLifecycleGeneration) return;
      // A busy bounded readback pool retries the entire batch; events are never coalesced.
      if (!results.length) { this._pendingGPUEvents.unshift(...events); return; }
      const snapshots = new Map(results.filter(r => r.valid).map(r => [`${r.slot}:${r.generation}`, r.particle]));
      for (const event of events) {
        const particle = snapshots.get(`${event.slot}:${event.generation}`);
        if (particle) this._dispatchSourceEvent(particle, event.event, event.data);
      }
    }).catch(error => { console.warn('RZMPS: GPU event targeting readback failed.', error); });
  }

  private _subscribes(options: SubSystemOptions, event: string): boolean {
    return (event === 'spawn' && options.emitOnSpawn)
      || (event === 'death' && options.emitOnDeath)
      || (event === 'collision' && options.emitOnCollision)
      || eventNames(options.onEvent).includes(event);
  }

  private _dispatchSourceEvent(source: SubSystemSource, event: string, data?: unknown,
    skipGPUConsumers = false, collision?: CollisionHit): void {
    const hit = data as CollisionHit | undefined;
    if (!collision && event === 'collision' && hit?.point instanceof THREE.Vector3
      && hit.normal instanceof THREE.Vector3 && hit.impulse instanceof THREE.Vector3) collision = hit;
    this.subSystems.forEach((options, child) => {
      if (skipGPUConsumers && child._canHandleNativeGPUEvent(this, options, event)) return;
      if (!this._subscribes(options, event) || !this._canEmitForParticle(source, options)) return;
      if (collision && collision.impulse.length() <= options.impulseThreshold) return;
      child._startEmissionRunAtParticle(source, options, collision, cpuEventHandler(options.onEvent, event), data);
    });
  }

  private _discoverEventTypes(): void {
    // IDs persist for the lifetime of the system: dispatch never changes this map.
    for (const options of this.subSystems.values()) {
      for (const name of eventNames(options.onEvent)) {
        if (this._eventTypes.has(name)) continue;
        if (this._eventTypes.size >=
          32) throw new Error('RZMPS supports at most 32 event types (3 built-in + 29 custom) per parent system.');
        this._eventTypes.set(name, this._eventTypes.size + 1);
      }
    }
  }

  /** Adds a system to this system as a subsystem, using this system's particles as its emission points. */
  public addSubSystem(subSystem: ParticleSystem, options: Partial<SubSystemOptions>): this {
    // No adding recursive self
    if (subSystem === this) return this;
    if (new Set([...this._eventTypes.keys(), ...eventNames(options.onEvent)]).size > 32) {
      throw new Error('RZMPS supports at most 32 event types (3 built-in + 29 custom) per parent system.');
    }

    // Replace existing parent
    if (subSystem._subSystemParent && subSystem._subSystemParent !== this) {
      subSystem._subSystemParent.removeSubSystem(subSystem);
    }

    // Configure emission condition
    const emitOnCollision = options.emitOnCollision ?? false;
    const emitOnSpawn = options.emitOnSpawn ?? false;
    const emitOnDeath = options.emitOnDeath ?? false;
    const emitContinuous = options.emitContinuous ?? !(emitOnCollision || emitOnDeath || emitOnSpawn ||
      eventNames(options.onEvent).length);

    this.subSystems.set(subSystem, {
      shouldEmit: options.shouldEmit ?? true,
      tags: options.tags?.slice(),
      onEvent: options.onEvent,
      ratio: THREE.MathUtils.clamp(options.ratio ?? 1, 0, 1),
      emitContinuous,
      emitOnCollision,
      emitOnSpawn,
      emitOnDeath,
      inheritScale: options.inheritScale ?? 1,
      inheritLifetime: options.inheritLifetime ?? (emitContinuous ? 1 : 0),
      inheritColor: options.inheritColor ?? 1,
      inheritAlpha: options.inheritAlpha ?? 1,
      inheritMass: options.inheritMass ?? 1,
      inheritVelocity: options.inheritVelocity ?? 0,

      // Impulse options
      impulseAffectsScale: options.impulseAffectsScale ?? 0,
      impulseAffectsSpeed: options.impulseAffectsSpeed ?? 0,
      impulseAffectsLifetime: options.impulseAffectsLifetime ?? 0,
      impulseAffectsMass: options.impulseAffectsMass ?? 0,
      impulseAffectsAlignment: options.impulseAffectsAlignment ?? false,
      impulseThreshold: Math.max(0, options.impulseThreshold ?? 0),
    });

    this._discoverEventTypes();
    subSystem._subSystemParent = this;
    subSystem.simulationSpace = this.simulationSpace;

    // Identity local transform makes the subsystem share this system's space.
    subSystem.position.set(0, 0, 0);
    subSystem.rotation.set(0, 0, 0);
    subSystem.scale.set(1, 1, 1);
    this.add(subSystem);

    return this;
  }

  /** Detaches a subsystem without destroying it; its simulation can then be advanced independently. */
  public removeSubSystem(subSystem: ParticleSystem): this {
    if (!this.subSystems.delete(subSystem)) return this;
    for (const source of this._emissionSources.values()) {
      subSystem.emitters.forEach(emitter => emitter.clearContext(source.id));
    }

    subSystem._subSystemParent = undefined;
    if (subSystem.parent === this) this.remove(subSystem);
    return this;
  }

  /*
    * LISTENERS
  */

  /** Registers a synchronous listener for particle expiry; returns the system for composition. */
  public onDeath(listener: ParticleListener): this {
    this._deathListeners.push(listener);
    return this;
  }

  /** Unregisters a previously attached death listener. */
  public removeDeathListener(listener: ParticleListener): this {
    this._deathListeners = this._deathListeners.filter((value) => value !== listener);
    return this;
  }

  /** Registers a synchronous listener for emitter births. */
  public onSpawn(listener: ParticleListener): this {
    this._spawnListeners.push(listener);
    return this;
  }

  /** Unregisters a previously attached spawn listener. */
  public removeSpawnListener(listener: ParticleListener): this {
    this._spawnListeners = this._spawnListeners.filter((value) => value !== listener);
    return this;
  }

  /** Registers a synchronous listener for collisions reported by a Collision module. */
  public onCollision(listener: CollisionListener): this {
    this._collisionListeners.push(listener);
    return this;
  }

  /** Unregisters a previously attached collision listener. */
  public removeCollisionListener(listener: CollisionListener): this {
    this._collisionListeners = this._collisionListeners.filter((value) => value !== listener);
    return this;
  }

  // Called by Collision after a hit is found.
  /** Reports a contact to listeners and starts eligible collision-triggered subsystem emissions. */
  public notifyCollision(particle: Particle, collision: CollisionHit): void {
    this._collisionListeners.forEach((listener) => listener(particle, collision));

    this._dispatchSourceEvent(particle, 'collision', collision, false, collision);
  }

  private _notifyDeath(particle: Particle, skipGPUConsumers = false): void {
    this._deathListeners.forEach(listener => listener(particle));
    this._dispatchSourceEvent(particle, 'death', undefined, skipGPUConsumers);
  }

  private _notifySpawn(particle: Particle): void {
    particle.setEventOwner(this);
    this._spawnListeners.forEach(listener => listener(particle));
    this._dispatchSourceEvent(particle, 'spawn');
  }

  private _dispatchGPUSpawnEvent(particle: Particle): void {
    this._spawnListeners.forEach(listener => listener(particle));
    this._dispatchSourceEvent(particle, 'spawn', undefined, true);
  }

  private _dispatchGPUCollisionEvent(particle: Particle, collision: CollisionHit): void {
    this.modules.flatMap(module => module.withDependents())
      .filter((module): module is Collision => module instanceof Collision)
      .forEach(module => module.notifyGPUCollision(particle, collision));
    this._collisionListeners.forEach(listener => listener(particle, collision));
    this._dispatchSourceEvent(particle, 'collision', collision, true, collision);
  }

  private cleanup(): void {
    this._disposeGPUComputeCaches();

    this.modules
      .flatMap((module) => module.withDependents())
      .forEach((module) => module.cleanup());

    this.renderers.forEach((renderer) => renderer.clear());

    this._worldRendererRoot.removeFromParent();
  }

  private getEmitterContext(): Partial<EmissionContext> {
    const context = {
      time: this.duration === 0 ? 1 : this._elapsedTime / this.duration,
      elapsedTime: this._elapsedTime,
      position: this.position,
      velocity: this.inheritVelocity > 0
        ? this._emitterContextVelocity.clone().multiplyScalar(this.inheritVelocity)
        : undefined,
    };

    if (this.simulationSpace !== SimulationSpace.World) return context;

    this.updateWorldMatrix(true, false);
    const transform = this.matrixWorld.clone();

    return {
      ...context,
      transform,
      position: new THREE.Vector3().setFromMatrixPosition(transform),
    };
  }

  private _updateEmitterContextVelocity(): void {
    this.updateWorldMatrix(true, false);
    this._emitterContextWorldPosition.setFromMatrixPosition(this.matrixWorld);

    if (
      !this._hasEmitterContextPreviousWorldPosition
      || this.deltaTime <= 0
    ) {
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
    this.getWorldQuaternion(worldQuaternion).invert();
    this._emitterContextVelocity.applyQuaternion(worldQuaternion);
  }

  private _resetEmitterContextVelocity(): void {
    this._emitterContextVelocity.set(0, 0, 0);
    this._hasEmitterContextPreviousWorldPosition = false;
  }

  private _updateSystemTime(): void {
    this._elapsedTime += this.deltaTime;

    if (this.looping) {
      while (this.duration > 0 && this._elapsedTime >= this.duration) {
        this._elapsedTime -= this.duration;
        this.emitters.forEach((emitter) => emitter.reset());
        this._gpuStandaloneEmitterInstances?.reset();
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

    const fps = Number.isFinite(this.prewarmFPS) && this.prewarmFPS > 0
      ? this.prewarmFPS
      : 24;
    const frameDuration = 1 / fps;
    const previousDeltaTime = this.deltaTime;
    const previousGPUProcessing = this._gpuProcessing;
    const canPrewarmOnCPU = previousGPUProcessing
      && this.modules
        .flatMap((module) => module.withDependents())
        .every((module) => module._modify !== Module.CPU_UNSUPPORTED);
    if (canPrewarmOnCPU) {
      // A synchronous prewarm loop cannot await hundreds of GPU dispatches safely.
      // Build authoritative CPU state, then let the next GPU frame upload it once.
      this._gpuProcessing = false;
      this._processingMode = 'cpu';
    }
    let remaining = this.duration;

    this.emitters.forEach((emitter) => emitter.reset());
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

    this.traverse((child) => {
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
    if (this.simulationSpace !== SimulationSpace.World) return this;

    return this._worldRendererRoot;
  }

  private syncRendererParents(): void {
    const worldRendererParent = this.getWorldRendererParent();

    if (this.simulationSpace === SimulationSpace.World) {
      if (worldRendererParent && this._worldRendererRoot.parent !== worldRendererParent) {
        worldRendererParent.add(this._worldRendererRoot);
      }
    } else if (this._worldRendererRoot.parent) {
      this._worldRendererRoot.removeFromParent();
    }

    const parent = this.getRendererParent();
    this._rendererObjects.forEach((object) => {
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

  private convertParticlesToSimulationSpace(space: SimulationSpace): void {
    this.updateWorldMatrix(true, false);

    if (space === SimulationSpace.World) {
      const normalMatrix = this._directionNormalMatrix.getNormalMatrix(this.matrixWorld);

      this.particles.forEach((particle) => {
        particle.localToWorld(this.matrixWorld, normalMatrix);
      });
    } else {
      const inverseWorldMatrix = this._inverseWorldMatrix.copy(this.matrixWorld).invert();
      const normalMatrix = this._directionNormalMatrix.getNormalMatrix(this.matrixWorld).invert();

      this.particles.forEach((particle) => {
        particle.worldToLocal(inverseWorldMatrix, normalMatrix);
      });
    }
  }

  private localDirectionToWorld(vector: THREE.Vector3): void {
    vector.applyMatrix3(this._directionNormalMatrix.getNormalMatrix(this.matrixWorld));
  }

}

export default ParticleSystem;
