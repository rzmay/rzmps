import { nanoid } from 'nanoid';
import * as THREE from 'three';
import type { Tag } from './types/Tag';

export interface ParticleOptions {
  position: THREE.Vector3;
  orbitCenter: THREE.Vector3;
  rotation: THREE.Vector3;
  scale: THREE.Vector3;
  velocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;
  scalarVelocity: THREE.Vector3;
  acceleration: THREE.Vector3;
  angularAcceleration: THREE.Vector3;
  scalarAcceleration: THREE.Vector3;
  speed: number;
  color: THREE.Color;
  tags: Tag[];
  alpha: number;
  lifetime: number;
  mass: number;
  distortionStrength: number;
}

export type ParticleStartValues = Required<Omit<ParticleOptions, 'tags'>> & { tags?: Tag[] };
export type ParticleCachedValues = Omit<ParticleStartValues, 'tags'>;

export interface ParticleNoiseValues {
  noise: number;
  noise4d: number;
}

class Particle {
  position: THREE.Vector3;

  orbitCenter: THREE.Vector3;

  rotation: THREE.Vector3;

  scale: THREE.Vector3;

  velocity: THREE.Vector3;

  angularVelocity: THREE.Vector3;

  scalarVelocity: THREE.Vector3;

  acceleration: THREE.Vector3;

  angularAcceleration: THREE.Vector3;

  scalarAcceleration: THREE.Vector3;

  speed: number;

  color: THREE.Color;

  alpha: number;

  mass: number = 0;

  distortionStrength: number = 1;

  startTime: number;

  lifetime: number;

  time: number;

  realtime: number;

  id: string;

  private _start: ParticleStartValues;

  get start(): Readonly<ParticleStartValues> {
    return this._start;
  }

  private _cachedValues?: ParticleCachedValues;

  noise: Record<string, ParticleNoiseValues>;

  tags?: Tag[];

  // Used to store custom data for special components
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;

  constructor(options: Partial<ParticleOptions> = {}) {
    this.position = options.position?.clone() ?? new THREE.Vector3();
    this.orbitCenter = options.orbitCenter?.clone() ?? this.position.clone();
    this.rotation = options.rotation?.clone() ?? new THREE.Vector3();
    this.scale = options.scale?.clone() ?? new THREE.Vector3(1, 1, 1);
    this.velocity = options.velocity?.clone() ?? new THREE.Vector3(0, 0, 0);
    this.angularVelocity = options.angularVelocity?.clone() ?? new THREE.Vector3(0, 0, 0);
    this.scalarVelocity = options.scalarVelocity?.clone() ?? new THREE.Vector3(0, 0, 0);
    this.acceleration = options.acceleration?.clone() ?? new THREE.Vector3(0, 0, 0);
    this.angularAcceleration = options.angularAcceleration?.clone() ?? new THREE.Vector3(0, 0, 0);
    this.scalarAcceleration = options.scalarAcceleration?.clone() ?? new THREE.Vector3(0, 0, 0);
    this.speed = options.speed ?? 1;
    this.color = options.color?.clone() ?? new THREE.Color(0xffffff);
    this.alpha = options.alpha ?? 1;
    this.mass = options.mass ?? 0;
    this.distortionStrength = options.distortionStrength ?? 1;

    this.lifetime = options.lifetime ?? 5;
    this.startTime = Date.now();
    this.time = 0;
    this.realtime = 0;

    this.id = nanoid();
    this.tags = options.tags ? [...options.tags] : undefined;

    this._start = this.createValues();
    this.noise = {};
    this.data = {};
  }

  cache() {
    this._cachedValues = this.writeValues(this._cachedValues);
  }

  cacheValues(values: ParticleCachedValues) {
    this._cachedValues = this.writeValues(this._cachedValues);
    this._cachedValues.lifetime = values.lifetime;
    this._cachedValues.position.copy(values.position);
    this._cachedValues.orbitCenter.copy(values.orbitCenter);
    this._cachedValues.rotation.copy(values.rotation);
    this._cachedValues.scale.copy(values.scale);
    this._cachedValues.velocity.copy(values.velocity);
    this._cachedValues.angularVelocity.copy(values.angularVelocity);
    this._cachedValues.scalarVelocity.copy(values.scalarVelocity);
    this._cachedValues.acceleration.copy(values.acceleration);
    this._cachedValues.angularAcceleration.copy(values.angularAcceleration);
    this._cachedValues.scalarAcceleration.copy(values.scalarAcceleration);
    this._cachedValues.speed = values.speed;
    this._cachedValues.mass = values.mass;
    this._cachedValues.distortionStrength = values.distortionStrength;
    this._cachedValues.color.copy(values.color);
    this._cachedValues.alpha = values.alpha;
  }

  restore() {
    if (!this._cachedValues) return;

    this.applyValues(this._cachedValues);
  }

  snapshot(): ParticleCachedValues {
    return this.writeValues();
  }

  localToWorld(matrixWorld: THREE.Matrix4, normalMatrix: THREE.Matrix3): void {
    this.position.applyMatrix4(matrixWorld);
    this.orbitCenter.applyMatrix4(matrixWorld);
    this.velocity.applyMatrix3(normalMatrix);
    this.scalarVelocity.applyMatrix3(normalMatrix);
    this.acceleration.applyMatrix3(normalMatrix);
    this.scalarAcceleration.applyMatrix3(normalMatrix);

    this._start.position.applyMatrix4(matrixWorld);
    this._start.orbitCenter.applyMatrix4(matrixWorld);
    this._start.velocity.applyMatrix3(normalMatrix);
    this._start.scalarVelocity.applyMatrix3(normalMatrix);
    this._start.acceleration.applyMatrix3(normalMatrix);
    this._start.scalarAcceleration.applyMatrix3(normalMatrix);

    this._cachedValues = undefined;
  }

  worldToLocal(inverseWorldMatrix: THREE.Matrix4, inverseNormalMatrix: THREE.Matrix3): void {
    this.position.applyMatrix4(inverseWorldMatrix);
    this.orbitCenter.applyMatrix4(inverseWorldMatrix);
    this.velocity.applyMatrix3(inverseNormalMatrix);
    this.scalarVelocity.applyMatrix3(inverseNormalMatrix);
    this.acceleration.applyMatrix3(inverseNormalMatrix);
    this.scalarAcceleration.applyMatrix3(inverseNormalMatrix);

    this._start.position.applyMatrix4(inverseWorldMatrix);
    this._start.orbitCenter.applyMatrix4(inverseWorldMatrix);
    this._start.velocity.applyMatrix3(inverseNormalMatrix);
    this._start.scalarVelocity.applyMatrix3(inverseNormalMatrix);
    this._start.acceleration.applyMatrix3(inverseNormalMatrix);
    this._start.scalarAcceleration.applyMatrix3(inverseNormalMatrix);

    this._cachedValues = undefined;
  }

  private createValues(): ParticleStartValues {
    return {
      ...this.writeValues(),
      tags: this.tags ? [...this.tags] : undefined,
    };
  }

  private writeValues<T extends ParticleCachedValues>(target?: T): T {
    const values = target ?? {
      position: new THREE.Vector3(),
      orbitCenter: new THREE.Vector3(),
      rotation: new THREE.Vector3(),
      scale: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      angularVelocity: new THREE.Vector3(),
      scalarVelocity: new THREE.Vector3(),
      acceleration: new THREE.Vector3(),
      angularAcceleration: new THREE.Vector3(),
      scalarAcceleration: new THREE.Vector3(),
      color: new THREE.Color(),
      lifetime: 0,
      speed: 1,
      alpha: 1,
      mass: 0,
      distortionStrength: 1,
    } as T;

    values.lifetime = this.lifetime;
    values.position.copy(this.position);
    values.orbitCenter.copy(this.orbitCenter);
    values.rotation.copy(this.rotation);
    values.scale.copy(this.scale);
    values.velocity.copy(this.velocity);
    values.angularVelocity.copy(this.angularVelocity);
    values.scalarVelocity.copy(this.scalarVelocity);
    values.acceleration.copy(this.acceleration);
    values.angularAcceleration.copy(this.angularAcceleration);
    values.scalarAcceleration.copy(this.scalarAcceleration);
    values.speed = this.speed;
    values.mass = this.mass;
    values.distortionStrength = this.distortionStrength;
    values.color.copy(this.color);
    values.alpha = this.alpha;

    return values;
  }

  private applyValues(values: ParticleCachedValues): void {
    this.lifetime = values.lifetime;
    this.position.copy(values.position);
    this.orbitCenter.copy(values.orbitCenter);
    this.rotation.copy(values.rotation);
    this.scale.copy(values.scale);
    this.velocity.copy(values.velocity);
    this.angularVelocity.copy(values.angularVelocity);
    this.scalarVelocity.copy(values.scalarVelocity);
    this.acceleration.copy(values.acceleration);
    this.angularAcceleration.copy(values.angularAcceleration);
    this.scalarAcceleration.copy(values.scalarAcceleration);
    this.speed = values.speed;
    this.mass = values.mass;
    this.distortionStrength = values.distortionStrength;
    this.color.copy(values.color);
    this.alpha = values.alpha;
  }
}

export default Particle;
