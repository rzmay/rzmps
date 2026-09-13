/* eslint-disable no-continue */
/* eslint-disable no-restricted-syntax */
/* eslint-disable class-methods-use-this */
/* eslint-disable new-cap */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import type {
  ICollisionBackend,
  CollisionHit,
  CollisionQuery,
} from '@rzmps/rzmps';
import {
  AmmoLike,
  AmmoRigidBodyLike,
  AmmoWorldLike,
} from './interfaces';

type AmmoCollisionData = {
  body: any;
};

type AmmoRayHit = {
  fraction: number;
  offset: THREE.Vector3;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  body?: AmmoRigidBodyLike;
};

export interface AmmoCollisionBackendOptions {
  Ammo: any;
  world: any;
}

class AmmoCollisionBackend implements ICollisionBackend {
  private Ammo: AmmoLike;

  private world: AmmoWorldLike;

  constructor(options: AmmoCollisionBackendOptions) {
    this.Ammo = options.Ammo;
    this.world = options.world;
  }

  collide(query: CollisionQuery): CollisionHit | null {
    const movement = query.end.clone().sub(query.start);

    if (movement.lengthSq() === 0) return null;

    const direction = movement.clone().normalize();
    const basis = this._getSweepBasis(direction, query.radius);

    let hit: AmmoRayHit | null = null;

    for (const offset of basis) {
      const rayHit = this._castRay(
        query.start.clone().add(offset),
        query.end.clone().add(offset),
        movement,
        offset,
      );

      if (!rayHit) continue;

      if (!hit || rayHit.fraction < hit.fraction) {
        hit = rayHit;
      }
    }

    if (!hit) return null;

    const position = hit.point
      .clone()
      .sub(hit.offset)
      .addScaledVector(hit.normal, query.radius + 1e-4);

    return {
      point: hit.point,
      normal: hit.normal,
      position,
      backendData: { body: hit.body },
    };
  }

  applyImpulse(
    hit: CollisionHit,
    impulse: THREE.Vector3,
  ): void {
    const data = hit.backendData as AmmoCollisionData | undefined;

    if (!data?.body) return;
    if (
      typeof data.body.getCenterOfMassPosition !== 'function'
      || typeof data.body.applyImpulse !== 'function'
    ) {
      return;
    }

    const ammoImpulse = new this.Ammo.btVector3(
      impulse.x,
      impulse.y,
      impulse.z,
    );

    const worldPoint = new this.Ammo.btVector3(
      hit.point.x,
      hit.point.y,
      hit.point.z,
    );

    const center = data.body.getCenterOfMassPosition();

    const relativePosition = new this.Ammo.btVector3(
      worldPoint.x() - center.x(),
      worldPoint.y() - center.y(),
      worldPoint.z() - center.z(),
    );

    data.body.activate(true);

    data.body.applyImpulse(
      ammoImpulse,
      relativePosition,
    );

    this._destroy(ammoImpulse, worldPoint, relativePosition);
  }

  private _castRay(
    start: THREE.Vector3,
    end: THREE.Vector3,
    movement: THREE.Vector3,
    offset: THREE.Vector3,
  ): AmmoRayHit | null {
    const fromPosition = new this.Ammo.btVector3(
      start.x,
      start.y,
      start.z,
    );

    const toPosition = new this.Ammo.btVector3(
      end.x,
      end.y,
      end.z,
    );

    const callback = new this.Ammo.ClosestRayResultCallback(
      fromPosition,
      toPosition,
    );

    this.world.rayTest(fromPosition, toPosition, callback);

    if (!callback.hasHit()) {
      this._destroy(fromPosition, toPosition, callback);
      return null;
    }

    const hitNormal = callback.get_m_hitNormalWorld();
    const normal = new THREE.Vector3(
      hitNormal.x(),
      hitNormal.y(),
      hitNormal.z(),
    ).normalize();

    if (movement.dot(normal) >= -1e-6) {
      this._destroy(fromPosition, toPosition, callback);
      return null;
    }

    const hitPoint = callback.get_m_hitPointWorld();
    const point = new THREE.Vector3(
      hitPoint.x(),
      hitPoint.y(),
      hitPoint.z(),
    );

    const collisionObject = callback.get_m_collisionObject();
    const body = this._getRigidBody(collisionObject);
    const fraction = callback.get_m_closestHitFraction();

    this._destroy(fromPosition, toPosition, callback);

    return {
      body,
      fraction,
      normal,
      offset,
      point,
    };
  }

  private _getSweepBasis(
    direction: THREE.Vector3,
    radius: number,
  ): THREE.Vector3[] {
    if (radius <= 0) return [new THREE.Vector3()];

    const tangent = new THREE.Vector3(0, 1, 0)
      .cross(direction);

    if (tangent.lengthSq() < 1e-6) {
      tangent.set(1, 0, 0).cross(direction);
    }

    tangent.normalize().multiplyScalar(radius);

    const bitangent = direction
      .clone()
      .cross(tangent)
      .normalize()
      .multiplyScalar(radius);

    return [
      new THREE.Vector3(),
      tangent,
      tangent.clone().negate(),
      bitangent,
      bitangent.clone().negate(),
    ];
  }

  private _getRigidBody(collisionObject: any): AmmoRigidBodyLike | undefined {
    if (this.Ammo.castObject) {
      return this.Ammo.castObject(
        collisionObject,
        this.Ammo.btRigidBody,
      );
    }

    return this.Ammo.btRigidBody.prototype.upcast?.(collisionObject);
  }

  private _destroy(...objects: any[]): void {
    objects.forEach((object) => this.Ammo.destroy(object));
  }
}

export default AmmoCollisionBackend;
