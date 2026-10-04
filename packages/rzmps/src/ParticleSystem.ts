import * as THREE from 'three';
import Particle, { type ParticleCachedValues } from './Particle';
import Emitter, { type EmissionContext } from './Emitter';
import Module from './Module';
import Renderer from './Renderer';
import acceptMultiple from './helpers/acceptMultiple';
import SpriteRenderer from './renderers/SpriteRenderer';
import type { Multiple } from './types/Multiple';
import type { DynamicValue } from './types/DynamicValue';
import evaluateDynamicNumber from './helpers/evaluateDynamicNumber';
import particleRatio from './helpers/particleRatio';
import { CollisionListener } from './modules/Collision';
import type { CollisionHit } from './interfaces/ICollisionBackend';
import type { Tag } from './types/Tag';
import { EndBehavior } from './enums/EndBehavior';
import { SimulationSpace } from './enums/SimulationSpace';
import { MaxCulling } from './enums/MaxCulling';
import { WebGPURenderer } from 'three/webgpu';
import { float, Fn, If, uint, vec3 } from 'three/tsl';
import LiveCubemap, { PARTICLE_RENDERER_OBJECT_KEY, type LiveCubemapOptions } from './renderers/LiveCubemap';
import LODHelper, { type LODSettings } from './LODHelper';
import {
  createGPUParticleBufferState,
  type GPUParticleBufferState,
  type GPUParticleUpdateContext,
} from './GPUParticle';
import { evaluateDynamicNumberGPU } from './helpers/evaluateDynamicGPU';
import SpatialEffect from './SpatialEffect';

interface ParticleSystemOptions {
  emitters: Multiple<Emitter>;
  renderers: Multiple<Renderer>;
  modules: Multiple<Module>;
  spatialEffects: Multiple<SpatialEffect>;
  spatialEffectFilter: (spatialEffect: SpatialEffect) => boolean;
  useSpatialEffects: boolean;
  simulationSpeed: number;
  duration: number;
  prewarm: boolean;
  prewarmFPS: number;
  looping: boolean;
  endBehavior: EndBehavior | `${EndBehavior}`;
  maxParticles: number;
  maxCullingMode: MaxCulling | `${MaxCulling}`;
  simulationDistance: number;
  useUpdateLOD: boolean;
  updateLOD: Partial<LODSettings>;
  gravity: THREE.Vector3;
  gravityModifier: DynamicValue<number>;
  inheritVelocity: number;
  simulationSpace: SimulationSpace | `${SimulationSpace}`;
  gpuProcessing: boolean;
  gpuDebug: boolean;
  gpuDebugInterval: number;

  useLiveCubemap: boolean;
  cubemapSettings: Partial<LiveCubemapOptions>;
  liveCubemapFPS: number;
  liveCubemapResolutionScale: number;
  liveCubemapIntensity: number;
}

export interface SubSystemOptions {
  shouldEmit: boolean | ((particle: Particle) => boolean);
  ratio: number;
  emitContinuous: boolean;
  emitOnCollision: boolean;
  emitOnSpawn: boolean;
  emitOnDeath: boolean;
  inheritScale: number;
  inheritLifetime: number;
  inheritColor: number;
  inheritAlpha: number;
  inheritMass: number;
  inheritVelocity: number;

  impulseAffectsScale: number;
  impulseAffectsSpeed: number;
  impulseAffectsLifetime: number;
  impulseAffectsMass: number;
  impulseAffectsAlignment: boolean;
  impulseThreshhold: number;
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
}

export type ParticleListener = (particle: Particle) => void;

class ParticleSystem extends THREE.Object3D {
  static GPU_DYNAMIC_VALUE_RESOLUTION = 16;
  static GPU_DEBUG = false;
  static GPU_DEBUG_INTERVAL = 30;

  particles: Particle[] = [];
  emitters: Emitter[] = [];
  modules: Module[] = [];
  spatialEffects: SpatialEffect[] = [];
  renderers: Renderer[] = [];
  subSystems = new Map<ParticleSystem, SubSystemOptions>();

  gravity: THREE.Vector3;
  gravityModifier: DynamicValue<number>;
  inheritVelocity: number;
  useSpatialEffects: boolean;
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
  useUpdateLOD: boolean;
  updateLOD?: Partial<LODSettings>;

  useLiveCubemap: boolean;
  liveCubemap: LiveCubemap;
  gpuProcessing: boolean;
  gpuDebug: boolean;
  gpuDebugInterval: number;
  private _isGPUProcessingActive = false;
  get isGPUProcessingActive(): boolean { return this._isGPUProcessingActive; }

  private _simulationSpace: SimulationSpace = SimulationSpace.Local;
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
  get sceneCamera() { return this._camera; }
  private readonly _sceneCameraQuaternion = new THREE.Quaternion();
  get sceneCameraQuaternion() { return this._sceneCameraQuaternion; }

  private _renderer?: THREE.WebGLRenderer | WebGPURenderer;
  get sceneRenderer() { return this._renderer; }
  private _cameraDistanceSq = Number.MAX_SAFE_INTEGER;
  get cameraDistanceSq(): number { return this._cameraDistanceSq; }

  private deltaTime = 0;
  private lastFrame: number;

  private _subSystemParent?: ParticleSystem;
  get isSubSystem(): boolean { return !!this._subSystemParent; }

  private _deathListeners: ParticleListener[] = [];
  private _spawnListeners: ParticleListener[] = [];
  private _collisionListeners: CollisionListener[] = [];

  private _emissionRuns: SubSystemEmissionRun[] = [];
  private _nextEmissionRunId = 0;

  private _playing = true;
  get playing(): boolean { return this._playing; }

  private _paused = false;
  get paused(): boolean { return this._paused; }

  private _ended = false;
  get ended(): boolean { return this._ended; }

  private _elapsedTime = 0;
  private _prewarmed = false;
  private _lodHelper: LODHelper;
  private _lodAccumulatedDeltaTime = 0;

  private _destroyed = false;
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
  private readonly _directionNormalMatrix = new THREE.Matrix3();
  private readonly _inverseWorldMatrix = new THREE.Matrix4();
  private _gpuBuffers?: GPUParticleBufferState;
  private _gpuTransientBaseBuffers?: GPUParticleBufferState;
  private _gpuRenderBuffers?: GPUParticleBufferState;
  private readonly _gpuTagRegistry = new Map<Tag, number>();
  private _gpuTagOverflow = false;
  private _gpuReadbackPending = false;
  private _gpuReadbacksInFlight = 0;
  private _gpuReadbackSequence = 0;
  private _latestAppliedGPUReadbackSequence = 0;
  private readonly _gpuDirtyParticleSlots = new Set<number>();
  private _gpuDebugFrame = 0;
  private _gpuDebugActiveFrame: number | undefined;

  constructor(options: Partial<ParticleSystemOptions> = {}) {
    super();

    this.emitters = acceptMultiple(options.emitters ?? new Emitter()) ?? [];
    this.renderers = acceptMultiple(options.renderers ?? new SpriteRenderer()) ?? [];
    this.modules = acceptMultiple(options.modules) ?? [];
    this.spatialEffects = acceptMultiple(options.spatialEffects) ?? [];
    this.spatialEffectFilter = options.spatialEffectFilter;
    this.useSpatialEffects = options.useSpatialEffects ?? true;
    this.simulationSpeed = options.simulationSpeed ?? 1;
    this.gpuProcessing = options.gpuProcessing ?? true;
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
    this.updateLOD = options.updateLOD;
    this.useUpdateLOD = options.useUpdateLOD ?? Boolean(this.updateLOD);
    this._lodHelper = new LODHelper(this.updateLOD);

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
  }

  /*
    * PROCESSING
  */

  update(): void {
    if (this._destroyed) return;

    // Subsystems are owned and ticked by parent, avoid double update
    if (this._subSystemParent) return;

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

    if (!this._isWithinSimulationDistance(simulationDistanceSq)) {
      this.deltaTime = nextDeltaTime;
      this.lastFrame = now;
      this._lodAccumulatedDeltaTime = 0;
      this._updateEmitterContextVelocity();
      return;
    }

    if (this.useUpdateLOD && !this._lodHelper.shouldUpdate(Math.sqrt(simulationDistanceSq))) {
      this._lodAccumulatedDeltaTime += nextDeltaTime;
      this.lastFrame = now;
      return;
    }

    this.deltaTime = nextDeltaTime + this._lodAccumulatedDeltaTime;
    this._lodAccumulatedDeltaTime = 0;
    this.lastFrame = now;

    this.syncRendererParents();
    this._updateEmitterContextVelocity();

    this._prewarm();

    if (this._playing) this._updateSystemTime();

    if (this._playing) this.emitters.forEach((emitter) => {
      const particles = emitter.update(this.particles, this.getEmitterContext(), this);
      particles.forEach((p) => this._notifySpawn(p));
    });

    // Particle processing
    this._processParticles();

    // Subsystems
    this._updateSubSystems();

    // Cubemap update
    if (this.useLiveCubemap) this.liveCubemap.update(this.scene, this.sceneRenderer, this.deltaTime);

    this._handleEndBehavior();
  }

  private _scaleDeltaTime(deltaTime: number): number {
    const speed = Number.isFinite(this.simulationSpeed)
      ? Math.max(0, this.simulationSpeed)
      : 1;

    return deltaTime * speed;
  }

  private _processParticles() {
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

    // Module preparation
    const modules = this.modules
      .flatMap((module) => module.withDependents());
    const spatialEffects = this._getSpatialEffects();

    this._prepareGPUTagRegistry(modules, spatialEffects);

    if (this._canProcessParticlesOnGPU(modules, spatialEffects)) {
      this._processParticlesGPU(modules, spatialEffects);
      return;
    }

    this._isGPUProcessingActive = false;

    modules
      .forEach((module) => module.prepare(this, this.deltaTime));

    this.particles.forEach((particle) => particle.restore());

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

    // Run transient render-time modules
    transientRenderModifiers
      .forEach((modifier) => modifier.modify(this.particles, this.deltaTime, this));

    this.renderers.forEach((renderer) => {
      renderer.update(this.particles, this, this.deltaTime);
    });
  }

  private _canProcessParticlesOnGPU(modules: Module[], spatialEffects: SpatialEffect[]): boolean {
    return this.gpuProcessing
      && this.sceneRenderer instanceof WebGPURenderer
      && !this._gpuTagOverflow
      && modules.every((module) => module.supportsGPU)
      && spatialEffects.every((spatialEffect) => spatialEffect.supportsGPU);
  }

  private _processParticlesGPU(modules: Module[], spatialEffects: SpatialEffect[]): void {
    const sceneRenderer = this.sceneRenderer;
    if (!(sceneRenderer instanceof WebGPURenderer)) return;

    const debugFrame = this._beginGPUDebugFrame(modules);
    const hasPendingReadback = this._gpuReadbackPending;

    if (hasPendingReadback) {
      this._logGPUDebug('readback pending; preserving GPU state', {
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

    if (!this._gpuBuffers) {
      this._gpuBuffers = createGPUParticleBufferState(
        this.particles,
        this.maxParticles,
        (particle) => this._getParticleGPUTagMask(particle),
      );
    } else if (hasPendingReadback) {
      this._gpuBuffers.uploadRange(
        this.particles,
        this._gpuBuffers.count,
        (particle) => this._getParticleGPUTagMask(particle),
      );
      this._uploadDirtyGPUParticleSlots(this._gpuBuffers);
    } else {
      this._gpuBuffers.upload(
        this.particles,
        (particle) => this._getParticleGPUTagMask(particle),
      );
    }
    const mainBufferInitialization = this._gpuBuffers.initialize(sceneRenderer);
    this._logGPUDebug('uploaded main buffer', {
      count: this._gpuBuffers.count,
      capacity: this._gpuBuffers.capacity,
      initialization: mainBufferInitialization,
      sample: this._sampleGPUParticles(this.particles),
    });

    if (!this._gpuTransientBaseBuffers) {
      this._gpuTransientBaseBuffers = createGPUParticleBufferState(
        this.particles,
        this.maxParticles,
        (particle) => this._getParticleGPUTagMask(particle),
      );
    } else if (hasPendingReadback) {
      this._gpuTransientBaseBuffers.uploadRange(
        this.particles,
        this._gpuTransientBaseBuffers.count,
        (particle) => this._getParticleGPUTagMask(particle),
      );
      this._uploadDirtyGPUParticleSlots(this._gpuTransientBaseBuffers);
    } else {
      this._gpuTransientBaseBuffers.upload(
        this.particles,
        (particle) => this._getParticleGPUTagMask(particle),
      );
    }
    const transientBaseBufferInitialization = this._gpuTransientBaseBuffers.initialize(sceneRenderer);
    this._logGPUDebug('uploaded transient-base buffer', {
      count: this._gpuTransientBaseBuffers.count,
      capacity: this._gpuTransientBaseBuffers.capacity,
      initialization: transientBaseBufferInitialization,
    });

    if (!this._gpuRenderBuffers) {
      this._gpuRenderBuffers = createGPUParticleBufferState(
        this.particles,
        this.maxParticles,
        (particle) => this._getParticleGPUTagMask(particle),
      );
    } else if (hasPendingReadback) {
      this._gpuRenderBuffers.uploadRange(
        this.particles,
        this._gpuRenderBuffers.count,
        (particle) => this._getParticleGPUTagMask(particle),
      );
      this._uploadDirtyGPUParticleSlots(this._gpuRenderBuffers);
    } else {
      this._gpuRenderBuffers.upload(
        this.particles,
        (particle) => this._getParticleGPUTagMask(particle),
      );
    }
    this._gpuDirtyParticleSlots.clear();
    const renderBufferInitialization = this._gpuRenderBuffers.initialize(sceneRenderer);

    const context: GPUParticleUpdateContext = {
      system: this,
      buffers: this._gpuBuffers,
      deltaTime: this.deltaTime,
    };
    const modifiers = [...modules, ...spatialEffects];

    const permanentPreMovementModifiers = modifiers
      .filter((module) => module.priority < 0)
      .sort((a, b) => a.priority - b.priority);

    this._logGPUDebug('phase: permanent pre-movement', {
      modifiers: this._describeGPUModifiers(permanentPreMovementModifiers),
    });
    this._computeGPUModifierPhase(permanentPreMovementModifiers, context, {
      skipReadbackSensitive: hasPendingReadback,
    });

    const transientPreMovementModifiers = modifiers
      .filter((module) => module.priority >= 0 && module.priority < 1)
      .sort((a, b) => a.priority - b.priority);

    if (transientPreMovementModifiers.length > 0) {
      this._logGPUDebug('copy main -> transient base before transient phase');
      this._copyGPUParticleBuffer(this._gpuBuffers, this._gpuTransientBaseBuffers);

      this._logGPUDebug('phase: transient pre-movement', {
        modifiers: this._describeGPUModifiers(transientPreMovementModifiers),
      });
      this._computeGPUModifierPhase(
        transientPreMovementModifiers,
        context,
        { skipReadbackSensitive: hasPendingReadback },
      );
    }

    this._logGPUDebug('phase: movement');
    this._computeGPUParticleMovement();

    if (transientPreMovementModifiers.length > 0) {
      this._logGPUDebug('commit transient frame -> permanent GPU state');
      this._commitGPUTransientFrame(this._gpuBuffers, this._gpuTransientBaseBuffers);
    }

    this._gpuReadbacksInFlight += 1;
    this._gpuReadbackPending = true;
    const readbackSequence = this._gpuReadbackSequence + 1;
    this._gpuReadbackSequence = readbackSequence;
    const readbackParticles = this.particles.slice(0, this._gpuBuffers.count);
    const readbackWasAlive = readbackParticles.map((particle) => particle.alive);
    const readbackStart = performance.now();
    this._logGPUDebug('readback requested', {
      readbackSequence,
      readbackSource: 'main',
      readbackParticleCount: readbackParticles.length,
      sample: this._sampleGPUParticles(readbackParticles),
    });
    const cpuMirrorUpdate = this._gpuBuffers.readback(sceneRenderer, readbackParticles);

    const transientRenderModifiers = modifiers
      .filter((module) => module.priority >= 1)
      .sort((a, b) => a.priority - b.priority);

    const cpuInputRenderers = this.renderers.filter((renderer) => !renderer.supportsGPUInput);
    const gpuInputRenderers = this.renderers.filter((renderer) => renderer.supportsGPUInput);
    const needsRenderBuffer = transientRenderModifiers.length > 0;

    if (needsRenderBuffer) {
      this._logGPUDebug('copy permanent state -> render buffer before render-time phase', {
        initialization: renderBufferInitialization,
      });
      this._copyGPUParticleBuffer(this._gpuBuffers, this._gpuRenderBuffers);

      this._logGPUDebug('phase: render-time transient', {
        target: 'render buffer',
        modifiers: this._describeGPUModifiers(transientRenderModifiers),
      });
      this._computeGPUModifierPhase(transientRenderModifiers, {
        system: this,
        buffers: this._gpuRenderBuffers,
        deltaTime: this.deltaTime,
      });
    } else {
      this._logGPUDebug('phase: render-time transient skipped on GPU', {
        reason: 'no renderers',
        modifiers: this._describeGPUModifiers(transientRenderModifiers),
      });
    }

    const renderBuffers = needsRenderBuffer ? this._gpuRenderBuffers : this._gpuBuffers;

    this._logGPUDebug('renderer handoff', {
      gpuRenderers: gpuInputRenderers.map((renderer) => renderer.constructor.name),
      cpuRenderers: cpuInputRenderers.map((renderer) => renderer.constructor.name),
      renderBuffer: needsRenderBuffer ? 'transient render buffer' : 'main buffer',
    });

    gpuInputRenderers.forEach((renderer) => {
      renderer.updateGPU(renderBuffers!, this, this.deltaTime);
    });

    const renderReadbackParticles = cpuInputRenderers.length > 0 && needsRenderBuffer
      ? this._cloneParticlesForGPUReadback(this.particles.slice(0, this._gpuRenderBuffers.count))
      : readbackParticles;
    const renderMirrorUpdate: Promise<Particle[]> = cpuInputRenderers.length > 0 && needsRenderBuffer
      ? this._gpuRenderBuffers.readback(sceneRenderer, renderReadbackParticles)
        .then(() => renderReadbackParticles)
      : cpuMirrorUpdate.then(() => readbackParticles);

    void (async () => {
      try {
        await cpuMirrorUpdate;

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
        this._applyGPUReadbackDeaths(readbackParticles, readbackWasAlive);

        const renderParticles = await renderMirrorUpdate;

        if (readbackSequence < this._latestAppliedGPUReadbackSequence) {
          this._logGPUDebug('render readback ignored: stale sequence', {
            readbackSequence,
            latestAppliedReadbackSequence: this._latestAppliedGPUReadbackSequence,
          });
          this._endGPUDebugFrame(debugFrame);
          return;
        }

        if (cpuInputRenderers.length > 0) {
          this._logGPUDebug('cpu renderer render-buffer readback resolved', {
            readbackSequence,
            sample: this._sampleGPUParticles(renderParticles),
          });

          cpuInputRenderers.forEach((renderer) => {
            renderer.update(renderParticles, this, this.deltaTime);
          });
        } else {
          this._logGPUDebug('cpu renderer render-buffer readback skipped', {
            reason: 'no CPU-input renderers',
          });
        }

        this._endGPUDebugFrame(debugFrame);
      } catch (error) {
        this._gpuReadbacksInFlight = Math.max(0, this._gpuReadbacksInFlight - 1);
        this._gpuReadbackPending = this._gpuReadbacksInFlight > 0;
        this._logGPUDebug('readback failed', {
          readbackSequence,
          error,
          errorMessage: error instanceof Error ? error.message : String(error),
          sample: this._sampleGPUParticles(this.particles),
        });

        cpuInputRenderers.forEach((renderer) => {
          renderer.update(this.particles, this, this.deltaTime);
        });

        this._endGPUDebugFrame(debugFrame);
      }
    })();
  }

  private _computeGPUParticleMovement(): void {
    if (!this._gpuBuffers?.count) return;
    if (!(this.sceneRenderer instanceof WebGPURenderer)) return;

    const particle = this._gpuBuffers.particle;
    const alive = this._gpuBuffers.alive;
    const deltaTime = float(this.deltaTime);
    const gravity = vec3(this.gravity);

    const computeNode = Fn(() => {
      If(alive.notEqual(uint(0)), () => {
        const gravityModifier = evaluateDynamicNumberGPU(
          this.gravityModifier,
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
          alive.assign(uint(0));
        });
      });
    })().compute(this._gpuBuffers.count);

    this.sceneRenderer.compute(computeNode);
  }

  private _copyGPUParticleBuffer(
    source: GPUParticleBufferState,
    target: GPUParticleBufferState,
  ): void {
    if (!source.count) return;
    if (!(this.sceneRenderer instanceof WebGPURenderer)) return;

    const sourceParticle = source.particle;
    const targetParticle = target.particle;

    const computeNode = Fn(() => {
      this._assignGPUParticleValues(targetParticle, sourceParticle);
      target.alive.assign(source.alive);
      target.tagMask.assign(source.tagMask);
    })().compute(source.count);

    this.sceneRenderer.compute(computeNode);
  }

  private _commitGPUTransientFrame(
    frameBuffers: GPUParticleBufferState,
    baseBuffers: GPUParticleBufferState,
  ): void {
    if (!frameBuffers.count) return;
    if (!(this.sceneRenderer instanceof WebGPURenderer)) return;

    const frame = frameBuffers.particle;
    const base = baseBuffers.particle;
    const alive = frameBuffers.alive;
    const deltaTime = float(this.deltaTime);
    const gravity = vec3(this.gravity);

    const computeNode = Fn(() => {
      If(alive.notEqual(uint(0)), () => {
        const frameStep = deltaTime.mul(frame.speed);
        const baseStep = deltaTime.mul(base.speed);
        const gravityModifier = evaluateDynamicNumberGPU(
          this.gravityModifier,
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

        If(frame.realtime.greaterThan(frame.lifetime.mul(1000)), () => {
          alive.assign(uint(0));
        });
      });
    })().compute(frameBuffers.count);

    this.sceneRenderer.compute(computeNode);
  }

  private _assignGPUParticleValues(
    target: GPUParticleBufferState['particle'],
    source: GPUParticleBufferState['particle'],
  ): void {
    target.position.assign(source.position);
    target.orbitCenter.assign(source.orbitCenter);
    target.rotation.assign(source.rotation);
    target.scale.assign(source.scale);
    target.velocity.assign(source.velocity);
    target.angularVelocity.assign(source.angularVelocity);
    target.scalarVelocity.assign(source.scalarVelocity);
    target.acceleration.assign(source.acceleration);
    target.angularAcceleration.assign(source.angularAcceleration);
    target.scalarAcceleration.assign(source.scalarAcceleration);
    target.color.assign(source.color);
    target.speed.assign(source.speed);
    target.alpha.assign(source.alpha);
    target.mass.assign(source.mass);
    target.distortionStrength.assign(source.distortionStrength);
    target.lifetime.assign(source.lifetime);
    target.time.assign(source.time);
    target.realtime.assign(source.realtime);
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

  private _computeGPUModifierPhase(
    modifiers: Array<Module | SpatialEffect>,
    context: GPUParticleUpdateContext,
    options: { skipReadbackSensitive?: boolean } = {},
  ): void {
    if (!modifiers.length || !context.buffers.count) return;
    if (!(this.sceneRenderer instanceof WebGPURenderer)) return;

    const renderer = this.sceneRenderer;
    const buffers = context.buffers;
    const particleCount = buffers.count;

    modifiers.forEach((modifier) => {
      const readbackSensitiveModifier = modifier instanceof Module
        ? modifier as Module & { canRunWithoutFreshGPUReadback?: () => boolean }
        : undefined;
      if (
        options.skipReadbackSensitive
        && readbackSensitiveModifier
        && readbackSensitiveModifier.requiresFreshGPUReadback
        && !readbackSensitiveModifier.canRunWithoutFreshGPUReadback?.()
      ) {
        this._logGPUDebug('skipping GPU modifier while CPU mirror is stale', {
          modifier: modifier.constructor.name,
        });
        return;
      }

      const computeNode = Fn(() => {
        const alive = buffers.alive.notEqual(uint(0));

        if (modifier instanceof Module) {
          const tagMask = this._getGPUTagMask(modifier.tags);
          const modifyParticle = () => {
            modifier.modifyGPU(buffers.particle, this.deltaTime, context);
          };

          if (tagMask === undefined) {
            If(alive, modifyParticle);
            return;
          }

          If(alive.and(buffers.tagMask.bitAnd(uint(tagMask)).notEqual(uint(0))), modifyParticle);
          return;
        }

        const tagMask = this._getGPUTagMask(modifier.tags);

        const applySpatialEffect = () => {
          const strength = modifier.testGPU(buffers.particle, context);

          If(strength.greaterThan(float(0)), () => {
            modifier.modifyGPU(buffers.particle, this.deltaTime, context, strength);
          });
        };

        if (tagMask === undefined) {
          If(alive, applySpatialEffect);
          return;
        }

        If(alive.and(buffers.tagMask.bitAnd(uint(tagMask)).notEqual(uint(0))), applySpatialEffect);
      })().compute(particleCount);

      renderer.compute(computeNode);
    });
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

    modules.forEach((module) => {
      module.tags?.forEach((tag) => this._registerGPUTag(tag));
    });
    spatialEffects.forEach((spatialEffect) => {
      spatialEffect.tags?.forEach((tag) => this._registerGPUTag(tag));
    });
    this.renderers.forEach((renderer) => {
      renderer.tags?.forEach((tag) => this._registerGPUTag(tag));
    });
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

  private _usesGPUStableParticleSlots(): boolean {
    return this._isGPUProcessingActive
      || (this.gpuProcessing && this.sceneRenderer instanceof WebGPURenderer);
  }

  private _uploadDirtyGPUParticleSlots(buffer: GPUParticleBufferState): void {
    this._gpuDirtyParticleSlots.forEach((index) => {
      const particle = this.particles[index];
      if (!particle) return;

      buffer.uploadIndex(
        index,
        particle,
        (value) => this._getParticleGPUTagMask(value),
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

      if (wasAlive[index] && !particle.alive) {
        this._notifyParticleDeath(particle);
      }
    });
  }

  private _notifyParticleDeath(particle: Particle): void {
    this._notifyDeath(particle);

    this.subSystems.forEach((_options, subSystem) => {
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

    const spatialEffects = this.spatialEffects
      .filter((spatialEffect) => (
        spatialEffect.modifiesParticles
        && (!this.spatialEffectFilter || this.spatialEffectFilter(spatialEffect))
      ));

    this.scene?.traverse((object) => {
      if (
        object instanceof SpatialEffect
        && object.modifiesParticles
        && (!this.spatialEffectFilter || this.spatialEffectFilter(object))
        && !spatialEffects.includes(object)
      ) spatialEffects.push(object);
    });

    return spatialEffects;
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
    this.subSystems.forEach((options, subSystem) => {
      subSystem._updateAsSubSystem(this.particles, options, this.deltaTime);
    });
  }

  private _updateAsSubSystem(
    parentParticles: Particle[],
    options: SubSystemOptions,
    parentDeltaTime: number,
  ): void {
    if (this._destroyed || this._paused) return;

    const simulationDistanceSq = this._getSimulationDistanceSq();
    this._cameraDistanceSq = simulationDistanceSq;
    if (!this._isWithinSimulationDistance(simulationDistanceSq)) {
      this._lodAccumulatedDeltaTime = 0;
      return;
    }

    const nextDeltaTime = this._scaleDeltaTime(parentDeltaTime);
    if (this.useUpdateLOD && !this._lodHelper.shouldUpdate(Math.sqrt(simulationDistanceSq))) {
      this._lodAccumulatedDeltaTime += nextDeltaTime;
      return;
    }

    this.syncRendererParents();
    this.deltaTime = nextDeltaTime + this._lodAccumulatedDeltaTime;
    this._lodAccumulatedDeltaTime = 0;
    if (options.emitContinuous) this._prewarm();
    if (this._playing && options.emitContinuous) this._updateSystemTime();

    if (this._playing && options.emitContinuous) {
      for (let i = 0; i < parentParticles.length; i += 1) {
        const particle = parentParticles[i];

        if (this._canEmitForParticle(particle, options)) {
          const transform = this._particleEmissionTransform(particle, options.inheritScale);
          const lifetime = options.inheritLifetime;

          this.emitters.forEach((emitter) => {
            const particles = emitter.update(this.particles, {
              key: particle.id,
              transform,
              position: particle.position,
              time: lifetime > 0 ? particle.time * lifetime : undefined,
              duration: lifetime > 0 ? THREE.MathUtils.lerp(this.duration, particle.lifetime, lifetime) : undefined,
              looping: lifetime > 0 ? false : this.looping,
              color: options.inheritColor > 0
                ? this._particleEmissionColor.set(1, 1, 1).lerp(particle.color, options.inheritColor)
                : undefined,
              alpha: options.inheritAlpha > 0
                ? THREE.MathUtils.lerp(1, particle.alpha, options.inheritAlpha)
                : undefined,
              mass: options.inheritMass > 0
                ? THREE.MathUtils.lerp(1, particle.mass, options.inheritMass)
                : undefined,
              velocity: options.inheritVelocity > 0
                ? this._particleEmissionVelocity.copy(particle.velocity).multiplyScalar(options.inheritVelocity)
                : undefined,
              tags: particle.tags,
            }, this);

            particles.forEach((p) => this._notifySpawn(p));
          });
        }
      }
    }

    if (this._playing) this._updateEmissionRuns(options);
    this._processParticles();
    this._updateSubSystems();
    if (options.emitContinuous) this._handleEndBehavior();
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

          const newParticles = emitter.update(this.particles, {
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
          }, this);

          newParticles.forEach((particle) => this._notifySpawn(particle));
        } else {
          emitter.clearContext(run.id);
        }
      });

      if (finished) {
        this._emissionRuns.splice(i, 1);
      }
    }
  }

  private _canEmitForParticle(particle: Particle, options: SubSystemOptions): boolean {
    if (!particleRatio(particle, options.ratio ?? 1)) return false;
    return typeof options.shouldEmit === 'function'
      ? options.shouldEmit(particle)
      : options.shouldEmit;
  }

  private _startEmissionRunAtParticle(
    particle: Particle,
    options: SubSystemOptions,
    collision?: CollisionHit
  ): void {
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
      particle.lifetime,
      options.inheritLifetime,
    );
    const impulseDuration = collision && options.impulseAffectsLifetime > 0
      ? this._getImpulseEffect(collision, options.impulseAffectsLifetime)
      : 0;
    const duration = baseDuration + impulseDuration;
    this._emissionRuns.push({
      id: `event_${this._nextEmissionRunId++}`,
      transform,
      startTime: now,
      realtime: 0,

      duration,

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
    particle: Particle,
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
  public start(children: boolean = true): void {
    const now = Date.now();

    this._playing = true;
    this._paused = false;
    this._ended = false;
    this._elapsedTime = 0;
    this.lastFrame = now;
    this._lodAccumulatedDeltaTime = 0;
    this._resetEmitterContextVelocity();
    this._lodHelper.reset();

    this.emitters.forEach((emitter) => emitter.reset());

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

  // Pause emission and simulation
  public pause(children: boolean = true): void {
    if (!this._playing || this._paused) return;
    this._paused = true;

    this.subSystems.forEach((_options, subSystem) => {
      subSystem.pause();
    });

    if (children) this._iterateChildren((child) => child.pause(false));
  }

  // Stop emission and optionally clear particles
  public stop(clearParticles: boolean, children: boolean = true): void {
    this._playing = false;
    this._paused = false;
    this._ended = true;
    this._prewarmed = false
    this._resetEmitterContextVelocity();
    this._lodHelper.reset();

    this.subSystems.forEach((_options, subSystem) => {
      subSystem.stop(clearParticles);
    });

    if (children) this._iterateChildren((child) => child.stop(clearParticles, false));

    this._emissionRuns.forEach((run) => {
      this.emitters.forEach((emitter) => {
        emitter.clearContext(run.id);
      });
    });

    this._emissionRuns.length = 0;

    // Child systems were handled above, so avoid propagating the clear a second time.
    if (clearParticles) this.clearParticles(false);
  }

  // Clear particles
  public clearParticles(children: boolean = true): void {
    this.particles.length = 0;
    this._gpuBuffers = undefined;
    this._gpuTransientBaseBuffers = undefined;
    this._gpuRenderBuffers = undefined;
    this._gpuReadbackPending = false;
    this._gpuReadbacksInFlight = 0;
    this._gpuReadbackSequence = 0;
    this._latestAppliedGPUReadbackSequence = 0;
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

  public destroy(children: boolean = true): void {
    if (this._destroyed) return;

    this._destroyed = true;
    this.stop(true, children);

    this.subSystems.forEach((_options, subSystem) => {
      subSystem.destroy();
    });

    if (children) this._iterateChildren((child) => child.destroy(false));

    this.renderers.forEach((renderer) => {
      renderer.destroy();
    });

    this.removeFromParent();
    this.cleanup();
    this.dispatchEvent({ type: 'destroyed' } as unknown as Parameters<typeof this.dispatchEvent>[0]);
  }

  /*
    * ACCESSING
  */

  public addParticle(particle: Particle, particles: Particle[] = this.particles): boolean {
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

  public addEmitter(emitter: Emitter): this {
    this.emitters.push(emitter);
    emitter.setup(this);

    return this;
  }

  public removeEmitter(emitter: Emitter): this {
    const index = this.emitters.indexOf(emitter);

    if (index !== -1) {
      this.emitters.splice(index, 1);
      this.remove(emitter.source);
    }

    return this;
  }

  public addModule(module: Module): this {
    this.modules.push(module);

    return this;
  }

  public removeModule(module: Module): this {
    const index = this.modules.indexOf(module);

    if (index !== -1) {
      this.modules.splice(index, 1);
      module.cleanup();
    }

    return this;
  }

  public addSpatialEffect(spatialEffect: SpatialEffect): this {
    this.spatialEffects.push(spatialEffect);

    return this;
  }

  public removeSpatialEffect(spatialEffect: SpatialEffect): this {
    const index = this.spatialEffects.indexOf(spatialEffect);

    if (index !== -1) {
      this.spatialEffects.splice(index, 1);
    }

    return this;
  }

  public addRenderer(renderer: Renderer): this {
    this.renderers.push(renderer);
    renderer.setup(this);
    this.syncRendererParents();

    return this;
  }

  public removeRenderer(renderer: Renderer): this {
    const index = this.renderers.indexOf(renderer);

    if (index !== -1) {
      this.renderers.splice(index, 1);
      renderer.destroy();
    }

    return this;
  }

  public addRendererObject(object: THREE.Object3D): void {
    object.userData[PARTICLE_RENDERER_OBJECT_KEY] = true;
    this._rendererObjects.add(object);
    this.getRendererParent().add(object);
  }

  public addSubSystem(subSystem: ParticleSystem, options: Partial<SubSystemOptions>): this {
    // No adding recursive self
    if (subSystem === this) return this;

    // Replace existing parent
    if (subSystem._subSystemParent && subSystem._subSystemParent !== this) {
      subSystem._subSystemParent.removeSubSystem(subSystem);
    }

    // Configure emission condition
    const emitOnCollision = options.emitOnCollision ?? false;
    const emitOnSpawn = options.emitOnSpawn ?? false;
    const emitOnDeath = options.emitOnDeath ?? false;
    const emitContinuous = options.emitContinuous ?? !(emitOnCollision || emitOnDeath || emitOnSpawn);

    this.subSystems.set(subSystem, {
      shouldEmit: options.shouldEmit ?? true,
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
      impulseThreshhold: Math.max(0, options.impulseThreshhold ?? 0),
    });

    subSystem._subSystemParent = this;
    subSystem.simulationSpace = this.simulationSpace;

    // Identity local transform makes the subsystem share this system's space.
    subSystem.position.set(0, 0, 0);
    subSystem.rotation.set(0, 0, 0);
    subSystem.scale.set(1, 1, 1);
    this.add(subSystem);

    return this;
  }

  public removeSubSystem(subSystem: ParticleSystem): this {
    if (!this.subSystems.delete(subSystem)) return this;

    subSystem._subSystemParent = undefined;
    if (subSystem.parent === this) this.remove(subSystem);
    return this;
  }

  /*
    * LISTENERS
  */

  public onDeath(listener: ParticleListener): this {
    this._deathListeners.push(listener);
    return this;
  }

  public removeDeathListener(listener: ParticleListener): this {
    this._deathListeners = this._deathListeners.filter((value) => value !== listener);
    return this;
  }

  public onSpawn(listener: ParticleListener): this {
    this._spawnListeners.push(listener);
    return this;
  }

  public removeSpawnListener(listener: ParticleListener): this {
    this._spawnListeners = this._spawnListeners.filter((value) => value !== listener);
    return this;
  }

  public onCollision(listener: CollisionListener): this {
    this._collisionListeners.push(listener);
    return this;
  }

  public removeCollisionListener(listener: CollisionListener): this {
    this._collisionListeners = this._collisionListeners.filter((value) => value !== listener);
    return this;
  }

  // Called by Collision after a hit is found.
  public notifyCollision(particle: Particle, collision: CollisionHit): void {
    this._collisionListeners.forEach((listener) => listener(particle, collision));

    this.subSystems.forEach((options, subSystem) => {
      if (
        options.emitOnCollision
        && collision.impulse.length() > options.impulseThreshhold
        && this._canEmitForParticle(particle, options)
      ) {
        subSystem._startEmissionRunAtParticle(particle, options, collision);
      }
    });
  }

  private _notifyDeath(particle: Particle): void {
    this._deathListeners.forEach((listener) => listener(particle));

    this.subSystems.forEach((options, subSystem) => {
      if (options.emitOnDeath && this._canEmitForParticle(particle, options)) {
        subSystem._startEmissionRunAtParticle(particle, options);
      }
    });
  }

  private _notifySpawn(particle: Particle): void {
    this._spawnListeners.forEach((listener) => listener(particle));

    this.subSystems.forEach((options, subSystem) => {
      if (options.emitOnSpawn && this._canEmitForParticle(particle, options)) {
        subSystem._startEmissionRunAtParticle(particle, options);
      }
    });
  }

  private cleanup(): void {
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
    let remaining = this.duration;

    this.emitters.forEach((emitter) => emitter.reset());
    this._elapsedTime = 0;

    while (remaining > 0 && !this._destroyed) {
      this.deltaTime = Math.min(frameDuration, remaining);

      this._updateSystemTime();

      if (this._playing) {
        this.emitters.forEach((emitter) => {
          const newParticles = emitter.update(this.particles, this.getEmitterContext(), this);
          newParticles.forEach((p) => this._notifySpawn(p));
        });
      }

      this._processParticles();
      this._updateSubSystems();

      remaining -= this.deltaTime;
    }

    this.useLiveCubemap = lastUseLiveCubemap;

    this.deltaTime = previousDeltaTime;
    this.lastFrame = Date.now();
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
