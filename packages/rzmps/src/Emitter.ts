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
    rateOverDistance: DynamicValue<number>;

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
  distanceCredit: number;
  lastDistancePosition?: THREE.Vector3;
  firedBursts: Set<number>;
}

export interface EmissionContext {
  key: string;
  transform: THREE.Matrix4;
  position: THREE.Vector3;
  time: number;
  elapsedTime: number;
  duration: number;
  looping: boolean;
  color: THREE.Color;
  alpha: number;
  mass: number;
  distortionStrength: number;
  velocity: THREE.Vector3;
  velocityScale: number;
  scale: number;
  tags: Tag[];
}

class Emitter {
  source: EmissionShape;
  rate: DynamicValue<number>;
  rateOverDistance: DynamicValue<number>;

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
  private _distancePosition = new THREE.Vector3();

  private _lastTagIndex: number = 0;

  // Used for subsystems
  private _contextStates = new Map<string, EmitterContextState>();

  constructor(
    options: Partial<EmitterOptions> = {},
  ) {
    this.source = options.source ?? EmissionShape.Sphere();
    this.initialValues = options.initialValues ?? {};

    this.bursts = acceptMultiple(options.bursts) ?? [];
    this.rate = options.rate ?? (this.bursts.length > 0 ? 0 : 50);
    this.rateOverDistance = options.rateOverDistance ?? 0;

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
      state.distanceCredit = 0;
      state.lastDistancePosition = undefined;
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

    const rateOverDistance = evaluateDynamicNumber(this.rateOverDistance, time) * emissionMultiplier;
    const distancePosition = this._getDistancePosition(context);
    if (rateOverDistance > 0 && distancePosition) {
      if (!state.lastDistancePosition) {
        state.lastDistancePosition = distancePosition.clone();
      } else {
        state.distanceCredit += state.lastDistancePosition.distanceTo(distancePosition) * rateOverDistance;
        state.lastDistancePosition.copy(distancePosition);
      }

      const particlesDue = Math.floor(state.distanceCredit);
      if (particlesDue > 0) {
        state.distanceCredit -= particlesDue;

        for (let i = 0; i < particlesDue; i += 1) {
          const particle = this.spawnParticle(particles, time, context);
          spawned.push(particle);
        }
      }
    } else if (distancePosition && state.lastDistancePosition) {
      state.lastDistancePosition.copy(distancePosition);
      state.distanceCredit = 0;
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
        distanceCredit: 0,
        firedBursts: new Set<number>(),
      };
      this._contextStates.set(key, state);
    }
    return state;
  }

  private _getDistancePosition(context: Partial<EmissionContext>): THREE.Vector3 | undefined {
    if (context.position) return context.position;
    if (!context.transform) return undefined;
    return this._distancePosition.setFromMatrixPosition(context.transform);
  }

  private spawnParticle(particles: Particle[], time: number, context: Partial<EmissionContext>): Particle {
    const point = this.source.getPoint();
    const position = point.position.clone();
    const orbitCenter = new THREE.Vector3();
    const normal = point.normal.clone();

    if (context.transform) {
      position.applyMatrix4(context.transform);
      orbitCenter.applyMatrix4(context.transform);
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

    let distortionStrength = evaluateDynamicNumber(this.initialValues.distortionStrength ?? 1, time);
    if (context.distortionStrength !== undefined) {
      distortionStrength *= context.distortionStrength;
    }

    const scale = evaluateDynamicVector(this.initialValues.scale ?? new THREE.Vector3(1, 1, 1), time);
    if (context.scale !== undefined) {
      scale.multiplyScalar(context.scale);
    }

    const speed = evaluateDynamicNumber(this.initialValues.speed ?? 1, time);
    const velocity = evaluateDynamicVector(this.initialValues.velocity ?? new THREE.Vector3(0, 0, 0), time).clone()
      .add(normal.multiplyScalar(
        evaluateDynamicNumber(this.radialSpeed, time),
      ));

    if (context.velocityScale !== undefined) {
      velocity.multiplyScalar(context.velocityScale);
    }

    if (context.velocity) {
      velocity.add(context.velocity);
    }

    const particle = new Particle({
      position,
      orbitCenter,
      rotation: evaluateDynamicVector(this.initialValues.rotation ?? rotation, time),
      scale,
      velocity,
      angularVelocity: this.initialValues.angularVelocity
        ? evaluateDynamicVector(this.initialValues.angularVelocity, time).clone()
        : undefined,
      scalarVelocity: this.initialValues.scalarVelocity
        ? evaluateDynamicVector(this.initialValues.scalarVelocity, time).clone()
        : undefined,
      acceleration: this.initialValues.acceleration
        ? evaluateDynamicVector(this.initialValues.acceleration, time).clone()
        : undefined,
      angularAcceleration: this.initialValues.angularAcceleration
        ? evaluateDynamicVector(this.initialValues.angularAcceleration, time).clone()
        : undefined,
      scalarAcceleration: this.initialValues.scalarAcceleration
        ? evaluateDynamicVector(this.initialValues.scalarAcceleration, time).clone()
        : undefined,
      speed,
      lifetime: evaluateDynamicNumber(this.initialValues.lifetime ?? 1, time),
      color,
      alpha,
      mass,
      distortionStrength,
      ...((this.tags || context.tags) && {
        tags: [...(context.tags ?? []), ...(this._selectTags() ?? [])],
      }),
    });

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
