import * as THREE from 'three';
import type { CollisionHit } from '../collision/collision.types';
import type Particle from '../core/Particle';
import particleRatio from '../core/particleRatio';
import type ParticleSystem from '../core/ParticleSystem';
import type { SubSystemOptions } from '../core/ParticleSystem';
import tagsIntersect from '../core/tags/tagsIntersect';
import type { SimulationEvent } from '../events/EventReceiver';
import EmissionSource, { type SubSystemSource } from './EmissionSource';
import Emitter, { type EmissionContext } from './Emitter';
import EmitterInstance from './EmitterInstance';

export interface EmissionExecution {
  deltaTime(): number;
  discardingTime(): boolean;
  clockWrap(): number;
  playing(): boolean;
  nativeEmission(): boolean;
  canUpdateAsGPUChild(parent: ParticleSystem, options: SubSystemOptions): boolean;
  eventNames(emitter: Emitter): string[];
  notifySpawn(particle: Particle): void;
  registerProducer(source: SubSystemSource, origin: ParticleSystem): void;
  activate(now: number): void;
}

/** Owns CPU emitter execution bindings, event snapshots and registered emission origins. */
export default class EmissionRuntime {
  constructor(readonly system: ParticleSystem, readonly execution: EmissionExecution) { }
  readonly _emissionSources = new Map<string, EmissionSource>();

  readonly _stagedBirths: Particle[] = [];

  readonly _emitterInstances = new Set<EmitterInstance>();

  _emitterInstanceEpoch = 0;

  _nextEmitterInstanceId = 0;

  _selectedEmitterSources(emitter: Emitter): SubSystemSource[] {
    const selector = emitter.sources;
    if (selector === undefined) return [];
    const ids = new Set(Array.isArray(selector) ? selector : (selector as { ids?: readonly string[] }).ids ?? []);
    const tags = Array.isArray(selector) ? [] : (selector as { tags?: readonly string[] }).tags ?? [];
    return emitter.visibleSystems(this.system).flatMap(owner => [...owner.emissionRuntime._emissionSources.values()])
      .filter(source => ids.has(source.id) || source.tags?.some(tag => tags.includes(tag)));
  }

  _activateEmitterInstance(
    emitter: Emitter,
    key: string,
    source?: SubSystemSource,
  ): EmitterInstance {
    const instance = emitter.getInstance(this.system, key);
    if (source) {
      if (instance.source.kind === 'live') instance.source.source = source;
      else instance.source = { kind: 'live', source };
    }
    instance.lastSeen = this._emitterInstanceEpoch;
    this._emitterInstances.add(instance);
    return instance;
  }

  _retireEmitterInstance(instance: EmitterInstance): void {
    instance.emitter.releaseInstance(this.system, instance);
    this._emitterInstances.delete(instance);
  }

  _advanceEmitterInstance(instance: EmitterInstance, options?: SubSystemOptions): void {
    if (this.execution.discardingTime() && instance.source.kind === 'snapshot' && instance.startTime === undefined) return;
    const context = instance.prepare(this.system, this.execution.deltaTime(), options);
    if (!context) {
      this._retireEmitterInstance(instance);
      return;
    }
    if (this.execution.discardingTime()) {
      instance.emitter.advanceClock(context, this.system, instance, this.execution.deltaTime(),
        instance.source.kind === 'standalone' ? this.execution.clockWrap() : 0);
      return;
    }
    // CPU-bound sources stage a single birth batch when the simulation runs on GPU.
    const parent = this.system.subSystemParent;
    const relationship = parent?.subSystems.get(this.system);
    const stage = (parent && relationship && this.execution.canUpdateAsGPUChild(parent, relationship))
      || (!this.system.isSubSystem && this.execution.nativeEmission());
    const particles = instance.emitter.update(
      stage ? this._stagedBirths : this.system.particles, { ...context, deltaTime: this.execution.deltaTime() }, this.system, instance,
    );
    if (!stage) particles.forEach(p => this.execution.notifySpawn(p));
  }

  _updateEmitterInstances(sources?: Iterable<SubSystemSource>): void {
    this._emitterInstanceEpoch += 1;
    // Open every receiver before emitting, so births cannot alter another receiver's current batch.
    const configurations = this.system.emitters.map(emitter => {
      const options = this.system.getEmitterOptions(emitter);
      if (!this.execution.discardingTime()) emitter.beginExecution(this.system, this.execution.deltaTime(),
        this.system.isSubSystem ? 'parent' : 'local', this.execution.eventNames(emitter), options.eventScope);
      return options;
    });
    for (const [index, emitter] of this.system.emitters.entries()) {
      const options = configurations[index];
      if (!this.execution.playing() || !options.emitContinuous) continue;

      // GPU particle bindings are discovered by indexed kernels; CPU sources use this same lifecycle.
      const liveSources = emitter.sources === undefined ? sources : this._selectedEmitterSources(emitter);
      if (liveSources) {
        for (const source of liveSources) {
          if (!this._canEmitForParticle(source, options)) continue;
          this._advanceEmitterInstance(this._activateEmitterInstance(emitter, source.id, source),
            options);
        }
      } else if (!this.system.isSubSystem && !this.execution.nativeEmission()) {
        this._advanceEmitterInstance(this._activateEmitterInstance(emitter, '__default'));
      }
    }
    if (!this.execution.playing()) return;

    // Retire undiscovered live bindings; snapshots preserve newest-first event ordering.
    const snapshots: EmitterInstance[] = [];
    for (const instance of this._emitterInstances) {
      if (!instance.active || (instance.source.kind !== 'snapshot'
        && instance.lastSeen !== this._emitterInstanceEpoch)) {
        this._retireEmitterInstance(instance);
      } else if (instance.source.kind === 'snapshot') snapshots.push(instance);
    }
    for (let i = snapshots.length - 1; i >= 0; i -= 1) this._advanceEmitterInstance(snapshots[i]);
  }

  _clearEmitterInstances(): void {
    for (const instance of this._emitterInstances) this._retireEmitterInstance(instance);
    for (const emitter of this.system.emitters) emitter.releaseInstances(this.system);
  }

  _canEmitForParticle(particle: SubSystemSource, options: SubSystemOptions): boolean {
    if (options.tags && !tagsIntersect(particle.tags ?? [], options.tags)) return false;
    if (!particleRatio(particle, options.ratio ?? 1)) return false;
    return typeof options.shouldEmit === 'function'
      ? options.shouldEmit(particle)
      : options.shouldEmit;
  }

  _activateEventEmitterInstances(
    emitter: Emitter,
    particle: SubSystemSource,
    options: SubSystemOptions,
    collisionHit?: CollisionHit,
    handler?: import('../events/events.utils').CPUEventHandler,
    data?: unknown,
    origin?: ParticleSystem,
    initializationEvent?: SimulationEvent,
  ): void {
    const collision = collisionHit && {
      ...collisionHit,
      point: collisionHit.point.clone(),
      normal: collisionHit.normal.clone(),
      impulse: collisionHit.impulse.clone(),
    };
    const now = Date.now();
    if (origin) this.execution.registerProducer(particle, origin);

    const impulse = collision?.impulse;
    const transform = this.system.getParticleEmissionTransform(
      particle,
      options.inheritScale,
      options.impulseAffectsAlignment ? impulse : undefined,
    );
    const baseDuration = THREE.MathUtils.lerp(
      this.system.duration,
      Number.isFinite(particle.lifetime) ? particle.lifetime : this.system.duration,
      options.inheritLifetime,
    );
    const impulseDuration = collision && options.impulseAffectsLifetime > 0
      ? this._getImpulseEffect(collision, options.impulseAffectsLifetime)
      : 0;
    const duration = baseDuration + impulseDuration;
    const inherited = EmitterInstance.sourceContext(this.system, particle, options);
    const baseContext = {
      ...inherited, transform, scale: this._getImpulseEffect(collision,
        options.impulseAffectsScale),
      velocityScale: this._getImpulseEffect(collision, options.impulseAffectsSpeed),
      duration, time: 0, elapsedTime: 0, looping: false, distortionStrength: 1,
      countScale: this._getImpulseEffect(collision, Math.max(0, options.impulseAffectsCount ?? 0)),
      tags: [],
      mass: (inherited.mass ?? 1) * (options.impulseAffectsMass > 0 ? this._getImpulseEffect(collision,
        options.impulseAffectsMass) : 1),
    } as EmissionContext;
    const overrides = handler?.(data, particle, baseContext);
    if (overrides === false) return;

    this.execution.activate(now);

    const eventContext = handler ? { ...baseContext, ...overrides } : undefined;
    if (eventContext) {
      eventContext.transform = eventContext.transform.clone();
      eventContext.position = eventContext.position.clone();
      eventContext.velocity = eventContext.velocity.clone();
      eventContext.color = eventContext.color.clone();
      eventContext.tags = eventContext.tags?.slice() ?? [];
      if (overrides?.position && !overrides.transform) eventContext.transform.setPosition(overrides.position);
      if (overrides?.transform && !overrides.position) eventContext.position.setFromMatrixPosition(overrides.transform);
    }
    // Freeze birth inputs without retaining a second source reference, identity or clock.
    const context = eventContext ?? baseContext;
    const instance = this._activateEmitterInstance(emitter, `event_${this._nextEmitterInstanceId++}`);
    instance.source = {
      kind: 'snapshot',
      source: particle.alive && !particle.id.startsWith('system:') ? particle : undefined,
      frame: this.system.getSourceEmissionFrame(particle),
      inputs: {
        event: initializationEvent,
        sourceToWorld: origin?.getSimulationToWorldMatrix().clone(),
        countScale: context.countScale,
        transform: context.transform,
        position: context.position,
        looping: context.looping,
        color: handler || options.inheritColor > 0 ? context.color : undefined,
        alpha: handler || options.inheritAlpha > 0 ? context.alpha : undefined,
        velocity: handler || options.inheritVelocity > 0 ? context.velocity : undefined,
        mass: handler || options.inheritMass > 0 ? context.mass
          : options.impulseAffectsMass > 0 ? this._getImpulseEffect(collision, options.impulseAffectsMass) : undefined,
        scale: context.scale,
        velocityScale: context.velocityScale,
        distortionStrength: context.distortionStrength,
        tags: context.tags,
      },
      elapsed: 0,
      duration: context.duration ?? duration,
    };
  }

  _getImpulseEffect(collision: CollisionHit | undefined, effect: number): number {
    return Math.pow(Math.max(0, collision?.impulse.length() ?? 1), effect);
  }
  updateSourceSnapshot(id: string, source: SubSystemSource): void {
    this._emitterInstances.forEach(instance => {
      const binding = instance.source;
      if (binding.kind !== 'standalone' && binding.source?.id === id) binding.source = source;
    });
  }

}
