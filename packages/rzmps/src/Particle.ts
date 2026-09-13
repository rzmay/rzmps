import { nanoid } from 'nanoid';
import * as THREE from 'three';
import { Tag } from './types/Tag';

export interface ParticleOptions {
  position: THREE.Vector3;
  rotation: THREE.Vector3;
  scale: THREE.Vector3;
  color: THREE.Color;
  tags: Tag[];
  alpha: number;
  lifetime: number;
  mass: number;
}

export interface ParticleStartValues {
  lifetime: number;
  position: THREE.Vector3;
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
  mass: number;
}

export interface ParticleNoiseValues {
  noise: number;
  noise4d: number;
}

class Particle {
  position: THREE.Vector3;

  rotation: THREE.Vector3;

  scale: THREE.Vector3;

  velocity: THREE.Vector3 = new THREE.Vector3(0, 0, 0);

  angularVelocity: THREE.Vector3 = new THREE.Vector3(0, 0, 0);

  scalarVelocity: THREE.Vector3 = new THREE.Vector3(0, 0, 0);

  acceleration: THREE.Vector3 = new THREE.Vector3(0, 0, 0);

  angularAcceleration: THREE.Vector3 = new THREE.Vector3(0, 0, 0);

  scalarAcceleration: THREE.Vector3 = new THREE.Vector3(0, 0, 0);

  speed: number = 1;

  color: THREE.Color;

  alpha: number;

  mass: number = 0;

  startTime: number;

  lifetime: number;

  time: number;

  realtime: number;

  id: string;

  start: ParticleStartValues;

  noise: Record<string, ParticleNoiseValues>;

  tags?: Tag[];

  // Used to store custom data for special components
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;

  constructor(options: Partial<ParticleOptions> = {}) {
    this.position = options.position ?? new THREE.Vector3();
    this.rotation = options.rotation ?? new THREE.Vector3();
    this.scale = options.scale ?? new THREE.Vector3(1, 1, 1);
    this.color = options.color ?? new THREE.Color(0xffffff);
    this.alpha = options.alpha ?? 1;
    this.mass = options.mass ?? 0;

    this.lifetime = options.lifetime ?? 5;
    this.startTime = Date.now();
    this.time = 0;
    this.realtime = 0;

    this.id = nanoid();
    this.tags = options.tags;

    this.start = this.createStartValues();
    this.noise = {};
    this.data = {};
  }

  cacheStartValues() {
    this.start = this.createStartValues();
  }

  private createStartValues(): ParticleStartValues {
    return {
      lifetime: this.lifetime,
      position: this.position.clone(),
      rotation: this.rotation.clone(),
      scale: this.scale.clone(),
      velocity: this.velocity.clone(),
      angularVelocity: this.angularVelocity.clone(),
      scalarVelocity: this.scalarVelocity.clone(),
      acceleration: this.acceleration.clone(),
      angularAcceleration: this.angularAcceleration.clone(),
      scalarAcceleration: this.scalarAcceleration.clone(),
      speed: this.speed,
      mass: this.mass,
      color: this.color.clone(),
      alpha: this.alpha,
    };
  }
}

export default Particle;
