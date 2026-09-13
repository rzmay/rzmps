import * as THREE from 'three';
import Particle from '../Particle';

export interface CollisionQuery {
  particle: Particle;
  start: THREE.Vector3;
  end: THREE.Vector3;
  radius: number;
}

export interface CollisionHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;

  // Corrected center position for the particle after collision.
  // If omitted, Collision falls back to point + normal * radius
  position?: THREE.Vector3;
  object?: THREE.Object3D;
  backendData?: unknown;
}

export interface ICollisionBackend {
  update?(deltaTime: number): void;
  collide(query: CollisionQuery): CollisionHit | null;
  applyImpulse?(
    hit: CollisionHit,
    impulse: THREE.Vector3,
  ): void;
  destroy?(): void;
}
