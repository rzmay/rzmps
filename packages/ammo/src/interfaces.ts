/* eslint-disable @typescript-eslint/no-explicit-any */
export interface AmmoVector3Like {
  x(): number;
  y(): number;
  z(): number;
}

export interface AmmoRigidBodyLike {
  activate(forceActivation?: boolean): void;
  applyImpulse(
    impulse: AmmoVector3Like,
    relativePosition: AmmoVector3Like,
  ): void;
  getCenterOfMassPosition(): AmmoVector3Like;
}

export interface AmmoLike {
  btVector3: new (
    x: number,
    y: number,
    z: number,
  ) => AmmoVector3Like;

  ClosestRayResultCallback: new (
    from: AmmoVector3Like,
    to: AmmoVector3Like,
  ) => any;

  btRigidBody: {
    prototype: {
      upcast?(object: any): AmmoRigidBodyLike;
    };
  };

  castObject?(
    object: any,
    klass: unknown,
  ): AmmoRigidBodyLike;

  destroy(object: unknown): void;
}

export interface AmmoWorldLike {
  rayTest(
    from: AmmoVector3Like,
    to: AmmoVector3Like,
    callback: any,
  ): void;
}
