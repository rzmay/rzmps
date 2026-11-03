import * as THREE from 'three';
import type Emitter from './Emitter';
import type { EmissionContext } from './Emitter';
import EmissionSource, { type SubSystemSource } from './EmissionSource';
import type ParticleSystem from './ParticleSystem';
import type { SubSystemOptions } from './ParticleSystem';
import { SimulationSpace } from './enums/SimulationSpace';

/** @internal
 * Internal bindings; snapshots retain event inputs rather than entire particles. */
export type EmitterInstanceSource =
  | { kind: 'standalone' }
  | { kind: 'live'; source: SubSystemSource }
  | {
    kind: 'snapshot';
    inputs: Omit<Partial<EmissionContext>, 'key' | 'source' | 'time' | 'elapsedTime' | 'duration'>;
    source?: SubSystemSource;
    frame?: THREE.Matrix4;
    elapsed: number;
    duration: number;
  };

/**
 * @internal
 * One CPU execution of an emitter definition. GPU executions use indexed entries in
 * GPUEmitterInstanceBufferState, with event inputs retained by GPUEmissionRunBufferState.
 * Configuration and all birth algorithms belong to Emitter, not this binding.
 */
export default class EmitterInstance {
  // Rate, distance and burst state is shared by every kind of execution.
  startTime: number | undefined = undefined;
  lastSpawn = 0;
  distanceCredit = 0;
  burstCredit = 0;
  lastDistancePosition: THREE.Vector3 | undefined = undefined;
  readonly firedBursts = new Set<number>();
  cycle: number | undefined = undefined;
  active = true;
  lastSeen = 0;

  constructor(
    readonly emitter: Emitter,
    readonly key: string,
    public source: EmitterInstanceSource = { kind: 'standalone' },
  ) {}

  reset(): void {
    this.startTime = undefined;
    this.lastSpawn = 0;
    this.distanceCredit = 0;
    this.burstCredit = 0;
    this.lastDistancePosition = undefined;
    this.firedBursts.clear();
    this.cycle = undefined;
  }

  /** Produces transient birth inputs, or retires a completed/lost-source execution. */
  prepare(system: ParticleSystem, deltaTime: number, options?: SubSystemOptions): Partial<EmissionContext> | undefined {
    const binding = this.source;
    if (!this.active) return;
    if (binding.kind === 'standalone') return system.getEmitterContext();
    if (binding.kind === 'live') {
      if (!binding.source.alive) return;
      return EmitterInstance.sourceContext(system, binding.source, options!);
    }

    if (system.simulationSpace === SimulationSpace.Source && binding.source && !binding.source.alive) return;
    binding.elapsed += deltaTime;
    if (!(binding.elapsed / binding.duration < 1)) return;

    const frame = system.getSourceEmissionFrame(binding.source);
    const change = frame && binding.frame ? frame.multiply(binding.frame.clone().invert()) : undefined;
    const inputs = binding.inputs;
    return {
      source: binding.source,
      key: this.key,
      time: binding.elapsed / binding.duration,
      elapsedTime: binding.elapsed,
      duration: binding.duration,
      looping: inputs.looping ?? false,
      transform: change && inputs.transform ? change.clone().multiply(inputs.transform) : inputs.transform,
      position: change ? inputs.position?.clone().applyMatrix4(change) : inputs.position,
      velocity: change
        ? inputs.velocity?.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(change)) : inputs.velocity,
      color: inputs.color,
      alpha: inputs.alpha,
      mass: inputs.mass,
      scale: inputs.scale,
      velocityScale: inputs.velocityScale,
      distortionStrength: inputs.distortionStrength,
      tags: inputs.tags,
    };
  }

  /** Shared inheritance inputs for live sources and event-time snapshots. */
  static sourceContext(
    system: ParticleSystem,
    source: SubSystemSource,
    options: SubSystemOptions,
  ): Partial<EmissionContext> {
    const lifetime = Number.isFinite(source.lifetime) ? options.inheritLifetime : 0;
    const parentToChild = system.getSimulationToWorldMatrix().invert()
      .multiply(system.getSourceProducer(source).getSimulationToWorldMatrix());
    return {
      source,
      key: source.id,
      transform: system.getParticleEmissionTransform(source, options.inheritScale),
      position: source.position.clone().applyMatrix4(parentToChild),
      time: lifetime > 0 ? source.time * lifetime : undefined,
      elapsedTime: source instanceof EmissionSource ? source.realtime / 1000 : undefined,
      duration: lifetime > 0 ? THREE.MathUtils.lerp(system.duration, source.lifetime, lifetime) : undefined,
      looping: lifetime > 0 ? false : system.looping,
      color: new THREE.Color(1, 1, 1).lerp(source.color, Math.max(0, options.inheritColor)),
      alpha: THREE.MathUtils.lerp(1, source.alpha, Math.max(0, options.inheritAlpha)),
      mass: THREE.MathUtils.lerp(1, source.mass, Math.max(0, options.inheritMass)),
      velocity: source.velocity.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(parentToChild))
        .multiplyScalar(Math.max(0, options.inheritVelocity)),
    };
  }
}
