import * as THREE from 'three';
import EmissionShape from './EmissionShape';
import Particle from './Particle';
import type { InitialParticleValues } from './interfaces/InitialParticleValues';
import evaluateDynamicVector from './helpers/evaluateDynamicVector3';
import evaluateDynamicNumber from './helpers/evaluateDynamicNumber';
import evaluateDynamicColor from './helpers/evaluateDynamicColor';
import acceptMultiple from './helpers/acceptMultiple';
import ParticleSystem from './ParticleSystem';
import type { DynamicUntimedValue, DynamicValue } from './types/DynamicValue';
import type { Multiple, StrictMultiple } from './types/Multiple';
import type { Tag } from './types/Tag';
import { TagSelectionMethod } from './enums/TagSelectionMethod';
import LODHelper, { type LODSettings } from './LODHelper';

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
    useUpdateLOD: boolean;
    updateLOD: Partial<LODSettings>;
    countLOD: Partial<LODSettings>;
}

interface EmitterContextState {
  startTime: number;
  lastSpawn: number;
  firedBursts: Set<number>;
}

export interface EmissionContext {
  key: string;
  transform: THREE.Matrix4;
  time: number;
  elapsedTime: number;
  duration: number;
  looping: boolean;
  color: THREE.Color;
  alpha: number;
  mass: number;
  velocityScale: number;
  scale: number;
  tags: Tag[];
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
  useUpdateLOD: boolean;
  updateLOD?: Partial<LODSettings>;
  countLOD?: Partial<LODSettings>;
  private _lodHelper: LODHelper;
  private _countLODHelper: LODHelper;

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
    this.updateLOD = options.updateLOD;
    this.useUpdateLOD = options.useUpdateLOD ?? Boolean(this.updateLOD);
    this.countLOD = options.countLOD;
    this._lodHelper = new LODHelper(this.updateLOD);
    this._countLODHelper = new LODHelper(this.countLOD);
  }

  /*
    * CONTROLS
  */

  public reset(): void {
    this.bursts.forEach((burst) => {
      burst.fired = false;
    });

    this._contextStates.clear();
    this._lodHelper.reset();
    this._countLODHelper.reset();
  }

  /*
    * SIMULATION
  */

  setup(particleSystem: ParticleSystem) {
    particleSystem.add(this.source);
  }

  update(
    particles: Particle[],
    context: Partial<EmissionContext>,
    particleSystem: ParticleSystem,
    deltaTime: number,
  ): Particle[] {
    if (
      this.useUpdateLOD
      && !this._lodHelper.shouldUpdate(Math.sqrt(particleSystem.cameraDistanceSq))
    ) return [];

    const now = Date.now();
    const elapsedMilliseconds = context.elapsedTime === undefined
      ? undefined
      : context.elapsedTime * 1000;
    const state = this.getContextState(context.key ?? '__default', elapsedMilliseconds ?? now);
    const duration = context.duration ?? particleSystem.duration;
    const elapsedTime = context.elapsedTime ?? ((now - state.startTime) / 1000);
    const time = context.time ?? (duration <= 0 ? 1 : elapsedTime / duration);
    const looping = context.looping ?? particleSystem.looping;
    const spawned: Particle[] = [];

    if (context.time === undefined && elapsedTime >= duration) {
      if (!looping) return spawned;

      state.startTime = now;
      state.lastSpawn = now;
      state.firedBursts.clear();

      return spawned;
    }

    const emissionMultiplier = this.countLOD
      ? this._countLODHelper.getScale(Math.sqrt(particleSystem.cameraDistanceSq))
      : 1;
    const rate = evaluateDynamicNumber(this.rate, time) * emissionMultiplier;
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
        const count = evaluateDynamicNumber(burst.count) * emissionMultiplier;
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

  private spawnParticle(particles: Particle[], time: number, context: Partial<EmissionContext>): Particle {
    const point = this.source.getPoint();
    const position = point.position.clone();
    const normal = point.normal.clone();

    if (context.transform) {
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
    if (context.color) {
      color.multiply(context.color);
    }

    let alpha = evaluateDynamicNumber(this.initialValues.alpha ?? 1, time);
    if (context.alpha !== undefined) {
      alpha *= context.alpha
    }

    let mass = evaluateDynamicNumber(this.initialValues.mass ?? 0, time);
    if (context.mass !== undefined) {
      mass *= context.mass;
    }

    const scale = evaluateDynamicVector(this.initialValues.scale ?? new THREE.Vector3(1, 1, 1), time);
    if (context.scale !== undefined) {
      scale.multiplyScalar(context.scale);
    }

    const particle = new Particle({
      position,
      rotation: evaluateDynamicVector(this.initialValues.rotation ?? rotation, time),
      scale,
      lifetime: evaluateDynamicNumber(this.initialValues.lifetime ?? 1, time),
      color,
      alpha,
      mass,
      ...((this.tags || context.tags) && {
        tags: [...(context.tags ?? []), ...(this._selectTags() ?? [])],
      }),
    });

    particle.speed = evaluateDynamicNumber(this.initialValues.speed ?? 1, time);

    particle.velocity = evaluateDynamicVector(this.initialValues.velocity ?? new THREE.Vector3(0, 0, 0), time).clone()
      .add(normal.multiplyScalar(
        evaluateDynamicNumber(this.radialSpeed, time),
      ));

    if (context.velocityScale !== undefined) {
      particle.velocity.multiplyScalar(context.velocityScale);
    }

    if (this.initialValues.angularVelocity)
      particle.angularVelocity = evaluateDynamicVector(this.initialValues.angularVelocity, time).clone();
    if (this.initialValues.scalarVelocity)
      particle.scalarVelocity = evaluateDynamicVector(this.initialValues.scalarVelocity, time).clone();

    if (this.initialValues.acceleration)
      particle.acceleration = evaluateDynamicVector(this.initialValues.acceleration, time).clone();
    if (this.initialValues.angularAcceleration)
      particle.angularAcceleration = evaluateDynamicVector(this.initialValues.angularAcceleration, time).clone();
    if (this.initialValues.scalarAcceleration)
      particle.scalarAcceleration = evaluateDynamicVector(this.initialValues.scalarAcceleration, time).clone();

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
