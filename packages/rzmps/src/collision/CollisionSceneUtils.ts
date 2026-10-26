import * as THREE from 'three';
import ParticleSystem from '../ParticleSystem';
import { TRAIL_RENDERER_USER_DATA_KEY } from '../renderers/TrailRenderer';
import { SPRITE_RENDERER_USER_DATA_KEY } from '../renderers/SpriteRenderer';

const IGNORED_COLLISION_OBJECT_TYPES = [
  THREE.BoxHelper,
  THREE.Box3Helper,
  THREE.AxesHelper,
  THREE.GridHelper,
  THREE.ArrowHelper,
  THREE.PlaneHelper,
  THREE.CameraHelper,
  THREE.SkeletonHelper,
  THREE.PolarGridHelper,
  THREE.DirectionalLightHelper,
  THREE.HemisphereLightHelper,
  THREE.SpotLightHelper,
  THREE.PointLightHelper,
] as Array<new (...args: never[]) => THREE.Object3D>;

const IGNORED_COLLISION_USER_DATA_KEYS = [
  TRAIL_RENDERER_USER_DATA_KEY,
  SPRITE_RENDERER_USER_DATA_KEY,
];

export function isIgnoredCollisionObject(object: THREE.Object3D): boolean {
  // Keep ParticleSystem as a live binding: collision modules participate in its
  // import cycle, so capturing it in the eager constructor array can store undefined.
  return object instanceof ParticleSystem
    || IGNORED_COLLISION_OBJECT_TYPES.some((Type) => object instanceof Type)
    || IGNORED_COLLISION_USER_DATA_KEYS.some((key) => Boolean(object.userData[key]));
}
