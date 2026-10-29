import * as THREE from 'three';
import { nanoid } from 'nanoid';
import type ParticleSystem from './ParticleSystem';
import type Particle from './Particle';
import type { Tag } from './types/Tag';

/** CPU-managed attributes in the owning system's simulation space. */
export interface EmissionSourceData {
  transform: THREE.Matrix4;
  tags?: Tag[];
  color?: THREE.Color;
  alpha?: number;
  scale?: number;
  velocity?: THREE.Vector3;
  mass?: number;
  distortionStrength?: number;
}

/** Common, read-only view accepted by subsystem selectors and event handlers. */
export type SubSystemSource = Readonly<Pick<Particle, 'id' | 'position' | 'rotation' | 'scale' | 'velocity' |
  'color' | 'alpha' | 'mass' | 'distortionStrength' | 'tags' | 'time' | 'realtime' | 'lifetime' | 'alive'>>;

/** A persistent emission origin, never inserted into the simulated particle population. */
export default class EmissionSource implements SubSystemSource {
  readonly id = `source:${nanoid()}`;
  /** Wall-clock registration timestamp; realtime tracks simulation age independently. */
  readonly registrationTime = Date.now();
  readonly position = new THREE.Vector3();
  readonly rotation = new THREE.Vector3();
  readonly scale = new THREE.Vector3(1, 1, 1);
  readonly velocity = new THREE.Vector3();
  readonly color = new THREE.Color(1, 1, 1);
  readonly transform = new THREE.Matrix4();
  tags?: Tag[];
  alpha = 1;
  mass = 1;
  distortionStrength = 1;
  lifetime = Infinity;
  time = 0;
  realtime = 0;
  alive = true;
  private scalarScale = 1;

  constructor(readonly system: ParticleSystem, data: EmissionSourceData) {
    this.apply(data);
  }

  /** Snapshot of canonical attributes; mutable values are copied. */
  get data(): EmissionSourceData {
    return { transform: this.transform.clone(), tags: this.tags?.slice(),
      color: this.color.clone(), alpha: this.alpha, scale: this.scalarScale,
      velocity: this.velocity.clone(), mass: this.mass, distortionStrength: this.distortionStrength };
  }

  update(changes: Partial<EmissionSourceData>): this { this.system.updateSource(this.id, changes); return this; }
  emitEvent(event: string, data?: unknown): this { this.system.emitEvent(this.id, event, data); return this; }
  dispose(): void { this.system.unregisterEmissionSource(this.id); }

  /** @internal CPU-only mutation; synchronization is deferred to the system update. */
  apply(data: Partial<EmissionSourceData>): void {
    if (data.transform) this.transform.copy(data.transform);
    if ('tags' in data) this.tags = data.tags?.slice();
    if (data.color) this.color.copy(data.color);
    if (data.velocity) this.velocity.copy(data.velocity);
    if (data.alpha !== undefined) this.alpha = data.alpha;
    if (data.mass !== undefined) this.mass = data.mass;
    if (data.distortionStrength !== undefined) this.distortionStrength = data.distortionStrength;
    if (data.scale !== undefined) this.scalarScale = data.scale;

    const q = new THREE.Quaternion();
    this.transform.decompose(this.position, q, this.scale);
    const e = new THREE.Euler().setFromQuaternion(q);
    this.rotation.set(e.x, e.y, e.z);
    this.scale.multiplyScalar(this.scalarScale);
  }
}
