import * as THREE from 'three';
import Particle, { ParticleOptions } from './Particle';
import Emitter from './Emitter';
import Module from './Module';
import Renderer from './Renderer';
import acceptMultiple from './helpers/acceptMultiple';
import SpriteRenderer from './renderers/SpriteRenderer';
import { Multiple } from './types/Multiple';
import { DynamicValue } from './types/DynamicValue';
import evaluateDynamicNumber from './helpers/evaluateDynamicNumber';
import particleRatio from './helpers/particleRatio';
import { CollisionListener } from './modules/Collision';
import { CollisionHit } from './interfaces/ICollisionBackend';
import { Tag } from './types/Tag';
import { EndBehavior } from './enums/EndBehavior';
import { SimulationSpace } from './enums/SimulationSpace';

interface ParticleSystemOptions {
  emitters: Multiple<Emitter>;
  renderers: Multiple<Renderer>;
  modules: Multiple<Module>;
  simulationSpeed: number;
  duration: number;
  looping: boolean;
  endBehavior: EndBehavior | `${EndBehavior}`;
  gravity: THREE.Vector3;
  gravityModifier: DynamicValue<number>;
  simulationSpace: SimulationSpace | `${SimulationSpace}`;
}

export interface SubSystemOptions {
  shouldEmit: boolean | ((particle: Particle) => boolean);
  ratio: number;
  emitContinuous: boolean;
  emitOnCollision: boolean;
  emitOnSpawn: boolean;
  emitOnDeath: boolean;
  inheritScale: boolean;
  inheritLifetime: boolean;
  inheritColor: boolean;
  inheritAlpha: boolean;
  inheritMass: boolean;
}

interface SubSystemEmissionRun {
  id: string;
  transform: THREE.Matrix4;
  startTime: number;
  realtime: number;
  duration?: number;
  particle: Omit<ParticleOptions, 'tags'> & { tags?: Tag[] };
}

export type ParticleListener = (particle: Particle) => void;

type EmitterContext = {
  transform?: THREE.Matrix4;
  time?: number;
  duration?: number;
  elapsedTime?: number;
  looping?: boolean;
};

class ParticleSystem extends THREE.Object3D {
  particles: Particle[] = [];
  emitters: Emitter[] = [];
  modules: Module[] = [];
  renderers: Renderer[] = [];
  subSystems = new Map<ParticleSystem, SubSystemOptions>();

  gravity: THREE.Vector3;
  gravityModifier: DynamicValue<number>;
  simulationSpeed: number;
  duration: number;
  looping: boolean;
  endBehavior: EndBehavior;

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

  private _renderer?: THREE.WebGLRenderer;
  get sceneRenderer() { return this._renderer; }

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
  private _paused = false;
  private _elapsedTime = 0;
  private _ended = false;
  private _destroyed = false;
  get destroyed(): boolean { return this._destroyed; }

  private readonly _rendererObjects = new Set<THREE.Object3D>();
  private readonly _worldRendererRoot = new THREE.Group();

  constructor(options: Partial<ParticleSystemOptions> = {}) {
    super();

    this.emitters = acceptMultiple(options.emitters ?? new Emitter()) ?? [];
    this.renderers = acceptMultiple(options.renderers ?? new SpriteRenderer()) ?? [];
    this.modules = acceptMultiple(options.modules) ?? [];
    this.simulationSpeed = options.simulationSpeed ?? 1;
    this.duration = options.duration ?? 10;
    this.looping = options.looping ?? true;
    this.endBehavior = (options.endBehavior as EndBehavior) ?? EndBehavior.None;

    // If gravity is passed in, gravityModifier will be set to 1.
    // In effect, this means gravity will be turned off by default,
    // but if either gravity or gravityModifier are specified, they will be used.
    this.gravity = options.gravity ?? new THREE.Vector3(0, -9.81, 0);
    this.gravityModifier = options.gravityModifier ?? (options.gravity ? 1 : 0);

    this._simulationSpace = (options.simulationSpace as SimulationSpace) ?? this._simulationSpace;
    this._worldRendererRoot.name = 'ParticleSystem World Renderers';

    this.lastFrame = Date.now();

    this.emitters.forEach((e) => e.setup(this));
    this.renderers.forEach((r) => r.setup(this));

    // Store these here so that other renderers/modules can access easily
    // Dummy mesh that renders nothing allows us to catch the onBeforeRender hook
    const dummy = new THREE.Mesh();
    this.add(dummy);

    dummy.onBeforeRender = (renderer, scene, camera) => {
      this._renderer = renderer;
      this._scene = scene;
      this._camera = camera;
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

    // Tick delta time before checking for pause so that it stays consistent betwee frames, not between processed frames
    this._calculateDeltaTime();

    // Check for pauses
    if (this._paused) return;

    this.syncRendererParents();

    if (this._playing) this._updateSystemTime();

    if (this._playing) this.emitters.forEach((emitter) => {
      const particles = emitter.update(this.particles, this.getEmitterContext());
      particles.forEach((p) => this._notifySpawn(p));
    });

    // Particle processing
    this._processParticles();

    // Subsystems
    this._updateSubSystems();
    this._handleEndBehavior();
  }

  private _calculateDeltaTime() {
    const now = Date.now();

    this.deltaTime = this._scaleDeltaTime((now - this.lastFrame) / 1000);
    this.lastFrame = now;
  }

  private _scaleDeltaTime(deltaTime: number): number {
    const speed = Number.isFinite(this.simulationSpeed)
      ? Math.max(0, this.simulationSpeed)
      : 1;

    return deltaTime * speed;
  }

  private _processParticles() {
    // Moudle preparation
    this.modules
      .flatMap((module) => module.withDependents())
      .forEach((module) => module.prepare(this, this.deltaTime));

    // Run pre modules
    this.modules
      .flatMap((module) => module.withDependents())
      .filter((module) => module.priority < 0)
      .forEach((module) => module.modify(this.particles, this.deltaTime));

    // Update particles
    this._updateParticles();

    // Run post modules
    this.modules
      .flatMap((module) => module.withDependents())
      .filter((module) => module.priority >= 0)
      .sort((a, b) => a.priority - b.priority)
      .forEach((module) => module.modify(this.particles, this.deltaTime));

    this.renderers.forEach((renderer) => {
      renderer.update(this.particles, this, this.deltaTime);
    });
  }

  private _updateParticles() {
    // Iterate over a copy of particles so that we can safely splice particles on death inside the loop
    [...this.particles].forEach((p, index) => {
      // Apply gravity
      p.velocity.addScaledVector(
        this.gravity,
        this.deltaTime * evaluateDynamicNumber(this.gravityModifier, p.time, p.id),
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
        this.particles.splice(index, 1);

        this.subSystems.forEach((_options, subSystem) => {
          subSystem.emitters.forEach((emitter) => emitter.clearContext(p.id));
        });
      }
    });
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
    if (!this._playing || this._paused) return;

    this.syncRendererParents();
    this.deltaTime = this._scaleDeltaTime(parentDeltaTime);
    this._updateSystemTime();

    if (options.emitContinuous) {
      parentParticles
        .filter((particle) => this._canEmitForParticle(particle, options))
        .forEach((particle) => {
          const transform = this._particleEmissionTransform(particle, options.inheritScale);

          this.emitters.forEach((emitter) => {
            const particles = emitter.updateAt(this.particles, {
              key: particle.id,
              transform,
              time: options.inheritLifetime ? particle.time : undefined,
              duration: options.inheritLifetime ? particle.lifetime : undefined,
              looping: options.inheritLifetime ? false : this.looping,
              color: options.inheritColor ? particle.color : undefined,
              alpha: options.inheritAlpha ? particle.alpha : undefined,
              mass: options.inheritMass ? particle.mass : undefined,
              tags: particle.tags,
            });

            particles.forEach((p) => this._notifySpawn(p));
          });
        });
    }

    this._updateEmissionRuns(options);
    this._processParticles();
    this._updateSubSystems();
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

          const newParticles = emitter.updateAt(this.particles, {
            key: run.id,
            transform: run.transform,
            time,
            duration,
            elapsedTime: elapsed,
            looping: false,
            color: options.inheritColor ? run.particle.color : undefined,
          });

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
  ): void {
    const now = Date.now();

    this._playing = true;
    this._paused = false;
    this._ended = false;
    this.lastFrame = now;

    this._emissionRuns.push({
      id: `event_${this._nextEmissionRunId++}`,
      transform: this._particleEmissionTransform(particle),
      startTime: now,
      realtime: 0,

      // If lifetime is inherited, use the parent's lifetime instead
      // of the subsystem emitter's configured duration.
      duration: options.inheritLifetime
        ? particle.lifetime
        : this.duration,

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
      },
    });
  }

  private _particleEmissionTransform(particle: Particle, inheritScale: boolean = false): THREE.Matrix4 {
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      particle.rotation.x,
      particle.rotation.y,
      particle.rotation.z,
    ));

    return new THREE.Matrix4().compose(
      particle.position,
      quaternion,
      inheritScale ? particle.scale : new THREE.Vector3(1, 1, 1),
    );
  }

  /*
    * CONTROL
  */

  // Start emitting
  public start(): void {
    const now = Date.now();

    this._playing = true;
    this._paused = false;
    this._ended = false;
    this._elapsedTime = 0;
    this.lastFrame = now;

    this.emitters.forEach((emitter) => emitter.reset());

    this.subSystems.forEach((_options, subSystem) => {
      subSystem.start();
    });

    this._emissionRuns.forEach((run) => {
      this.emitters.forEach((emitter) => emitter.clearContext(run.id));
    });

    this._emissionRuns.length = 0;
  }

  // Pause emission and simulation
  public pause(): void {
    if (!this._playing || this._paused) return;
    this._paused = true;

    this.subSystems.forEach((_options, subSystem) => {
      subSystem.pause();
    });
  }

  public resume(): void {
    if (!this._playing || !this._paused) return;

    this._paused = false;
    this.lastFrame = Date.now();

    const now = Date.now();

    this.particles.forEach((p) => {
      p.startTime = now - p.realtime;
    })

    this._emissionRuns.forEach((e) => {
      e.startTime = now - e.realtime * 1000;
    })

    this.subSystems.forEach((_options, subSystem) => {
      subSystem.resume();
    });
  }

  // Stop emission and optionally clear particles
  public stop(clearParticles: boolean): void {
    this._playing = false;
    this._paused = false;
    this._ended = true;

    this.subSystems.forEach((_options, subSystem) => {
      subSystem.stop(clearParticles);
    });

    this._emissionRuns.forEach((run) => {
      this.emitters.forEach((emitter) => {
        emitter.clearContext(run.id);
      });
    });

    this._emissionRuns.length = 0;

    if (clearParticles) this.clearParticles();
  }

  public destroy(): void {
    if (this._destroyed) return;

    this._destroyed = true;
    this.stop(true);

    this.subSystems.forEach((_options, subSystem) => {
      subSystem.destroy();
    });

    this.renderers.forEach((renderer) => {
      renderer.destroy();
    });

    this.removeFromParent();
    this.cleanup();
    this.dispatchEvent({ type: 'destroyed' } as unknown as Parameters<typeof this.dispatchEvent>[0]);
  }

  // Clear particles
  public clearParticles(): void {
    this.particles.length = 0;

    this.renderers.forEach((renderer) => {
      renderer.update(this.particles, this);
    });

    this.subSystems.forEach((_options, subSystem) => {
      subSystem.clearParticles();
    });
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
      this.modules.splice(index, 1);
      renderer.destroy();
    }

    return this;
  }

  public addRendererObject(object: THREE.Object3D): void {
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
      inheritScale: options.inheritScale ?? true,
      inheritLifetime: options.inheritLifetime ?? emitContinuous,
      inheritColor: options.inheritColor ?? true,
      inheritAlpha: options.inheritAlpha ?? true,
      inheritMass: options.inheritMass ?? true,
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
      if (options.emitOnCollision && this._canEmitForParticle(particle, options)) {
        subSystem._startEmissionRunAtParticle(particle, options);
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

  private getEmitterContext(): EmitterContext {
    const context: EmitterContext = {
      time: this.duration === 0 ? 1 : this._elapsedTime / this.duration,
      duration: this.duration,
      elapsedTime: this._elapsedTime,
      looping: this.looping,
    };

    if (this.simulationSpace !== SimulationSpace.World) return context;

    this.updateWorldMatrix(true, false);

    return {
      ...context,
      transform: this.matrixWorld.clone(),
    };
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
      this.particles.forEach((particle) => {
        this.localToWorld(particle.position);
        this.localDirectionToWorld(particle.velocity);
        this.localDirectionToWorld(particle.acceleration);
        this.localDirectionToWorld(particle.scalarVelocity);
        this.localDirectionToWorld(particle.scalarAcceleration);
        particle.cacheStartValues();
      });
    } else {
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(this.matrixWorld).invert();

      this.particles.forEach((particle) => {
        this.worldToLocal(particle.position);
        particle.velocity.applyMatrix3(normalMatrix);
        particle.acceleration.applyMatrix3(normalMatrix);
        particle.scalarVelocity.applyMatrix3(normalMatrix);
        particle.scalarAcceleration.applyMatrix3(normalMatrix);
        particle.cacheStartValues();
      });
    }
  }

  private localDirectionToWorld(vector: THREE.Vector3): void {
    vector.applyMatrix3(new THREE.Matrix3().getNormalMatrix(this.matrixWorld));
  }
}

export default ParticleSystem;
