import * as THREE from 'three';
import { nanoid } from 'nanoid';
import type ParticleSystem from '../core/ParticleSystem';
import type Particle from '../core/Particle';
import type { Tag } from '../types/tag.types';

/** CPU-managed attributes in the owning system's simulation space. */
export interface EmissionSourceData {
  /** Application metadata exposed to synchronous particle initializers. */
  metadata?: unknown;
  /** Seconds of owner-managed age. Supplying age makes the caller responsible for advancing the clock. */
  age?: number;
  /** Intrinsic source lifetime in seconds. A finite value defines emitter-curve sampling independently of child
   * duration; Infinity retains ordinary emitter-duration sampling and looping. */
  lifetime?: number;
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
  'color' | 'alpha' | 'mass' | 'distortionStrength' | 'tags' | 'time' | 'realtime' | 'lifetime' | 'age' | 'alive'>>
  & { readonly metadata?: unknown };

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
  metadata?: unknown;
  /** Refresh owner-driven attributes immediately before a consumer samples this source. @internal */
  prepareEmission?: () => void;
  private scalarScale = 1;
  private externallyTimed = false;

  get age(): number { return this.realtime / 1000; }

  /** Advance ordinary sources; owner-managed sources publish their own age/lifetime together. @internal */
  advanceClock(seconds: number, fallbackDuration: number): void {
    if (!this.externallyTimed) this.realtime += seconds * 1000;
    const duration = Number.isFinite(this.lifetime) ? this.lifetime : fallbackDuration;
    this.time = this.realtime / (Math.max(duration, Number.EPSILON) * 1000);
  }

  constructor(readonly system: ParticleSystem, data: EmissionSourceData) {
    this.apply(data);
  }

  /** Snapshot of canonical attributes; mutable values are copied. */
  get data(): EmissionSourceData {
    return { metadata: this.metadata, age: this.externallyTimed ? this.age : undefined,
      lifetime: this.lifetime, transform: this.transform.clone(), tags: this.tags?.slice(),
      color: this.color.clone(), alpha: this.alpha, scale: this.scalarScale,
      velocity: this.velocity.clone(), mass: this.mass, distortionStrength: this.distortionStrength };
  }

  update(changes: Partial<EmissionSourceData>): this { this.system.updateSource(this.id, changes); return this; }
  emitEvent(event: string, data?: unknown): this { this.system.emitEvent(this.id, event, data); return this; }
  dispose(): void { this.system.unregisterEmissionSource(this.id); }

  /** @internal CPU-only mutation; synchronization is deferred to the system update. */
  apply(data: Partial<EmissionSourceData>): void {
    if (data.lifetime !== undefined) {
      if (!(data.lifetime > 0)) throw new RangeError('Source lifetime must be positive or Infinity.');
      this.lifetime = data.lifetime;
    }
    if ('age' in data) {
      if (data.age !== undefined && (!Number.isFinite(data.age) || data.age < 0)) {
        throw new RangeError('Source age must be finite and nonnegative.');
      }
      this.externallyTimed = data.age !== undefined;
      if (data.age !== undefined) this.realtime = data.age * 1000;
    }
    if (this.externallyTimed) this.advanceClock(0, this.lifetime);
    if ('metadata' in data) this.metadata = data.metadata;
    if (data.transform) this.transform.copy(data.transform);
    if ('tags' in data) this.tags = data.tags?.slice();
    if (data.color) this.color.copy(data.color);
    if (data.velocity) this.velocity.copy(data.velocity);
    if (data.alpha !== undefined) this.alpha = data.alpha;
    if (data.mass !== undefined) this.mass = data.mass;
    if (data.distortionStrength !== undefined) this.distortionStrength = data.distortionStrength;
    if (data.scale !== undefined) this.scalarScale = data.scale;

    this.position.setFromMatrixPosition(this.transform);
    if (Math.abs(this.transform.determinant()) > 1e-10) {
      const q = new THREE.Quaternion();
      this.transform.decompose(this.position, q, this.scale);
      const e = new THREE.Euler().setFromQuaternion(q);
      this.rotation.set(e.x, e.y, e.z);
    } else {
      // Matrix4.decompose retains the destination scale for singular matrices. Preserve actual zero axes instead.
      this.scale.setFromMatrixScale(this.transform);
    }
    this.scale.multiplyScalar(this.scalarScale);
  }
}
