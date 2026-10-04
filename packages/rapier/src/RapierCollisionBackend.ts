import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type {
  ICollisionBackend,
  CollisionHit,
  CollisionQuery,
} from '@rzmps/rzmps';

type RapierCollisionData = {
  body?: RAPIER.RigidBody;
};

export interface RapierCollisionBackendOptions {
  RAPIER: (typeof RAPIER);
  world: RAPIER.World;
}

class RapierCollisionBackend implements ICollisionBackend {
  private RAPIER: typeof RAPIER;

  private world: RAPIER.World;

  constructor(options: RapierCollisionBackendOptions) {
    this.RAPIER = options.RAPIER;
    this.world = options.world;
  }

  collide(query: CollisionQuery): CollisionHit | null {
    const movement = query.end.clone().sub(query.start);

    if (movement.lengthSq() === 0) return null;

    const shape = new this.RAPIER.Ball(query.radius);

    const hit = this.world.castShape(
      query.start,
      {
        x: 0, y: 0, z: 0, w: 1,
      },
      movement,
      shape,
      0,
      1,
      true,
    );

    if (!hit) return null;

    const fraction = hit.time_of_impact ?? 0;

    const position = query.start
      .clone()
      .addScaledVector(movement, fraction);

    const normal = new THREE.Vector3(
      hit.normal1.x,
      hit.normal1.y,
      hit.normal1.z,
    ).normalize();

    const point = position
      .clone()
      .addScaledVector(normal, -query.radius);

    const impulse = normal
      .clone()
      .multiplyScalar(query.particle.mass)
      .multiplyScalar(
        Math.max(0, -query.velocity.dot(normal)),
      );

    return {
      point,
      normal,
      impulse,
      position: position.addScaledVector(normal, 1e-4),
      backendData: {
        body: hit.collider.parent() ?? undefined,
      } satisfies RapierCollisionData,
    };
  }

  // eslint-disable-next-line class-methods-use-this
  applyImpulse(
    hit: CollisionHit,
    impulse: THREE.Vector3,
  ): void {
    const data = hit.backendData as RapierCollisionData | undefined;

    const body = data?.body;

    if (!body || !body.isDynamic()) return;

    body.applyImpulseAtPoint(
      {
        x: impulse.x,
        y: impulse.y,
        z: impulse.z,
      },
      {
        x: hit.point.x,
        y: hit.point.y,
        z: hit.point.z,
      },
      true,
    );
  }
}

export default RapierCollisionBackend;
