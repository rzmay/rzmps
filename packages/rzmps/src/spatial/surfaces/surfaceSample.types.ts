import type { Vector3 } from 'three';
import type { Node } from 'three/webgpu';

/** World-space surface query. Positive distance is outside/in the outward-normal direction.
 * Mesh orientation follows triangle winding; an open mesh defines two oriented sides, not a closed interior.
 * Invalid queries suspend attachment (or kill when requested), without a global nearest-surface search. */
export interface SurfaceSample {
  distance: number;
  normal: Vector3;
  velocity: Vector3;
  valid?: boolean;
}

/** GPU equivalent of SurfaceSample. All vectors and distances are physical world-space values. */
export interface GPUSurfaceSample {
  distance: Node<'float'>;
  normal: Node<'vec3'>;
  velocity: Node<'vec3'>;
  valid: Node<'bool'>;
  /** Symmetric velocity strain magnitude in inverse seconds, when supplied by a liquid surface. */
  deformation?: Node<'float'>;
}

export type SurfaceQuery = (position: Vector3) => SurfaceSample;
export type GPUSurfaceQuery = (position: Node<'vec3'>) => GPUSurfaceSample;
