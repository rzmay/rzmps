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
import LiveCubemap, { PARTICLE_RENDERER_OBJECT_KEY, type LiveCubemapOptions } from './renderers/LiveCubemap';
import LODHelper, { type LODSettings } from './LODHelper';

interface ParticleSystemOptions {
  emitters: Multiple<Emitter>;
  renderers: Multiple<Renderer>;
  modules: Multiple<Module>;
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
  particles: Particle[] = [];
  emitters: Emitter[] = [];
  modules: Module[] = [];
  renderers: Renderer[] = [];
  subSystems = new Map<ParticleSystem, SubSystemOptions>();

  gravity: THREE.Vector3;
  gravityModifier: DynamicValue<number>;
  inheritVelocity: number;
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
  get scene() { return this._scene; }

  private _camera?: THREE.Camera;
  get sceneCamera() { return this._camera; }
  private readonly _sceneCameraQuaternion = new THREE.Quaternion();
  get sceneCameraQuaternion() { return this._sceneCameraQuaternion; }

  private _renderer?: THREE.WebGLRenderer;
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

  constructor(options: Partial<ParticleSystemOptions> = {}) {
    super();

    this.emitters = acceptMultiple(options.emitters ?? new Emitter()) ?? [];
    this.renderers = acceptMultiple(options.renderers ?? new SpriteRenderer()) ?? [];
    this.modules = acceptMultiple(options.modules) ?? [];
    this.simulationSpeed = options.simulationSpeed ?? 1;
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
      if (this.maxCullingMode == MaxCulling.New) this.particles.splice(this.maxParticles)
      else this.particles.splice(0, this.particles.length - this.maxParticles)
    }

    // Module preparation
    const modules = this.modules
      .flatMap((module) => module.withDependents());

    modules
      .forEach((module) => module.prepare(this, this.deltaTime));

    this.particles.forEach((particle) => particle.restore());

    const permanentPreMovementModules = modules
      .filter((module) => module.priority < 0)
      .sort((a, b) => a.priority - b.priority)
    const transientPreMovementModules = modules
      .filter((module) => module.priority >= 0 && module.priority < 1)
      .sort((a, b) => a.priority - b.priority);
    const transientRenderModules = modules
      .filter((module) => module.priority >= 1)
      .sort((a, b) => a.priority - b.priority);

    // Run permanent pre-movement modules
    permanentPreMovementModules
      .forEach((module) => module.modify(this.particles, this.deltaTime, this));

    const transientBaseValues = transientPreMovementModules.length > 0
      ? this.particles.map((particle) => particle.snapshot())
      : undefined;

    // Run transient pre-movement modules
    transientPreMovementModules
      .forEach((module) => module.modify(this.particles, this.deltaTime, this));

    // Update particles, caching permanent state before render-time transients.
    this._updateParticles(transientBaseValues);

    if (!transientBaseValues) {
      this.particles.forEach((particle) => particle.cache());
    }

    // Run transient render-time modules
    transientRenderModules
      .forEach((module) => module.modify(this.particles, this.deltaTime, this));

    this.renderers.forEach((renderer) => {
      renderer.update(this.particles, this, this.deltaTime);
    });
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
        this._notifyDeath(p);

        this.subSystems.forEach((_options, subSystem) => {
          subSystem.emitters.forEach((emitter) => emitter.clearContext(p.id));
        });

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
    next.angularVelocity.copy(base.angularVelocity).addScaledVector(base.angularAcceleration, this.deltaTime * base.speed);
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
    this._prewarmed = false;
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
    this._lodAccumulatedDeltaTime = 0;
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
      this._handleEndBehavior();

      remaining -= this.deltaTime;
    }

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
