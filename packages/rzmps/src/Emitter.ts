import * as THREE from 'three';
import EmissionShape from './EmissionShape';
import Particle from './Particle';
import { InitialParticleValues } from './interfaces/InitialParticleValues';
import evaluateDynamicVector from './helpers/evaluateDynamicVector3';
import evaluateDynamicNumber from './helpers/evaluateDynamicNumber';
import evaluateDynamicColor from './helpers/evaluateDynamicColor';
import acceptMultiple from './helpers/acceptMultiple';
import ParticleSystem from './ParticleSystem';
import { DynamicUntimedValue, DynamicValue } from './types/DynamicValue';
import { Multiple, StrictMultiple } from './types/Multiple';
import { Tag } from './types/Tag';
import { TagSelectionMethod } from './enums/TagSelectionMethod';

type SpawnBurst = {
    time: number,
    count: DynamicUntimedValue<number>,
    fired?: boolean,
};

interface EmitterOptions {
    initialValues: Partial<InitialParticleValues>;
    source: EmissionShape;
    bursts: Multiple<SpawnBurst>;
    rate: DynamicValue<number>;

    radialSpeed: DynamicValue<number>;
    alignment: DynamicValue<number>;

    tags: StrictMultiple<Tag>;
    tagSelection: TagSelectionMethod | `${TagSelectionMethod}`;
}

interface EmitterContextState {
  startTime: number;
  lastSpawn: number;
  firedBursts: Set<number>;
}

export interface EmissionContext {
  key?: string;
  transform?: THREE.Matrix4;
  time?: number;
  duration?: number;
  elapsedTime?: number;
  looping?: boolean;
  color?: THREE.Color;
  alpha?: number;
  mass?: number;
  tags?: Tag[];
}

class Emitter {
  source: EmissionShape;
  rate: DynamicValue<number>;

  bursts: SpawnBurst[];
  initialValues: Partial<InitialParticleValues>;
  radialSpeed: DynamicValue<number>;
  alignment: DynamicValue<number>;

  tags?: Tag[];
  tagSelection: TagSelectionMethod = TagSelectionMethod.All;

  private _lastTagIndex: number = 0;

  // Used for subsystems
  private _contextStates = new Map<string, EmitterContextState>();

  constructor(
    options: Partial<EmitterOptions> = {},
  ) {
    this.source = options.source ?? EmissionShape.Sphere();
    this.initialValues = options.initialValues ?? {};
    this.rate = options.rate ?? 50;
    this.bursts = acceptMultiple(options.bursts) ?? [];

    this.radialSpeed = options.radialSpeed ?? 1
    this.alignment = options.alignment ?? 0;

    this.tags = acceptMultiple(options.tags);
    this.tagSelection = (options.tagSelection as TagSelectionMethod) ?? this.tagSelection;
  }

  /*
    * CONTROLS
  */

  public reset(): void {
    this.bursts.forEach((burst) => {
      burst.fired = false;
    });

    this._contextStates.clear();
  }

  /*
    * SIMULATION
  */

  setup(particleSystem: ParticleSystem) {
    particleSystem.add(this.source);
  }

  update(particles: Particle[], context?: EmissionContext): Particle[] {
    return this.updateAt(particles, {
      ...context,
      key: context?.key ?? '__default',
    });
  }

  updateAt(particles: Particle[], context: EmissionContext): Particle[] {
    const now = Date.now();
    const elapsedMilliseconds = context.elapsedTime === undefined
      ? undefined
      : context.elapsedTime * 1000;
    const state = this.getContextState(context.key ?? '__default', elapsedMilliseconds ?? now);
    const duration = context.duration ?? 10;
    const elapsedTime = context.elapsedTime ?? ((now - state.startTime) / 1000);
    const time = context.time ?? (elapsedTime / duration);
    const looping = context.looping ?? true;
    const spawned: Particle[] = [];

    if (context.time === undefined && elapsedTime >= duration) {
      if (!looping) return spawned;

      state.startTime = now;
      state.lastSpawn = now;
      state.firedBursts.clear();

      return spawned;
    }

    const rate = evaluateDynamicNumber(this.rate, time);
    if (rate > 0) {
      const secondsPerParticle = 1000 / rate;
      const spawnClock = elapsedMilliseconds ?? now;
      const particlesDue = Math.floor((spawnClock - state.lastSpawn) / secondsPerParticle);

      for (let i = 0; i < particlesDue; i += 1) {
        const particle = this.spawnParticle(particles, time, context);

        spawned.push(particle);
      }

      if (particlesDue > 0) {
        state.lastSpawn = spawnClock;
      }
    }

    this.bursts.forEach((burst, index) => {
      if (!state.firedBursts.has(index) && burst.time <= time) {
        const count = evaluateDynamicNumber(burst.count)
        for (let i = 0; i < Math.floor(count); i += 1) {
          const particle = this.spawnParticle(particles, time, context);
          spawned.push(particle);
        }
        state.firedBursts.add(index);
      }
    });

    return spawned;
  }

  clearContext(key: string) {
    this._contextStates.delete(key);
  }

  private getContextState(key: string, startTime: number): EmitterContextState {
    let state = this._contextStates.get(key);
    if (!state) {
      state = {
        startTime,
        lastSpawn: startTime,
        firedBursts: new Set<number>(),
      };
      this._contextStates.set(key, state);
    }
    return state;
  }

  private spawnParticle(particles: Particle[], time: number, context?: EmissionContext): Particle {
    const point = this.source.getPoint();
    const position = point.position.clone();
    const normal = point.normal.clone();

    if (context?.transform) {
      position.applyMatrix4(context.transform);
      normal.applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(context.transform)).normalize();
    }

    const defaultRotationQuat = (new THREE.Quaternion).setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      normal
    );
    const defaultRotationEuler = new THREE.Euler().setFromQuaternion(defaultRotationQuat, 'YXZ');
    const defaultRotation = new THREE.Vector3(
      defaultRotationEuler.x,
      defaultRotationEuler.y,
      defaultRotationEuler.z
    );
    const rotation = new THREE.Vector3(0, 0, 0).lerp(
      defaultRotation,
      Math.max(Math.min(evaluateDynamicNumber(this.alignment, time), 1), 0),
    );

    const color = evaluateDynamicColor(this.initialValues.color ?? new THREE.Color(1, 1, 1), time);
    if (context?.color) {
      color.multiply(context.color);
    }

    let alpha = evaluateDynamicNumber(this.initialValues.alpha ?? 1, time);
    if (context?.alpha) {
      alpha *= context.alpha
    }

    let mass = evaluateDynamicNumber(this.initialValues.mass ?? 0, time);
    if (context?.mass) {
      mass *= context.mass;
    }

    const particle = new Particle({
      position,
      rotation: evaluateDynamicVector(this.initialValues.rotation ?? rotation, time),
      scale: evaluateDynamicVector(this.initialValues.scale ?? new THREE.Vector3(1, 1, 1), time),
      lifetime: evaluateDynamicNumber(this.initialValues.lifetime ?? 1, time),
      color,
      alpha,
      mass,
      ...((this.tags || context?.tags) && {
        tags: [...(context?.tags ?? []), ...(this._selectTags() ?? [])],
      }),
    });

    particle.speed = evaluateDynamicNumber(this.initialValues.speed ?? 1, time);

    particle.velocity = evaluateDynamicVector(this.initialValues.velocity ?? new THREE.Vector3(0, 0, 0), time).clone()
      .add(normal.multiplyScalar(
        evaluateDynamicNumber(this.radialSpeed, time),
      ));

    if (this.initialValues.angularVelocity) particle.angularVelocity = evaluateDynamicVector(this.initialValues.angularVelocity, time).clone();
    if (this.initialValues.scalarVelocity) particle.scalarVelocity = evaluateDynamicVector(this.initialValues.scalarVelocity, time).clone();

    if (this.initialValues.acceleration) particle.acceleration = evaluateDynamicVector(this.initialValues.acceleration, time).clone();
    if (this.initialValues.angularAcceleration) particle.angularAcceleration = evaluateDynamicVector(this.initialValues.angularAcceleration, time).clone();
    if (this.initialValues.scalarAcceleration) particle.scalarAcceleration = evaluateDynamicVector(this.initialValues.scalarAcceleration, time).clone();

    particle.cacheStartValues();
    particles.push(particle);

    return particle;
  }

  private _selectTags(): Tag[] | undefined {
    if (!this.tags) return;

    switch (this.tagSelection){
      case 'random':
        return [this.tags[Math.floor(Math.random() * this.tags.length)]]
      case 'distribute':
        this._lastTagIndex = (this._lastTagIndex + 1) % this.tags.length;
        return [this.tags[this._lastTagIndex]]
      case 'all':
      default:
        return this.tags;
    }
  }
}

export default Emitter;
