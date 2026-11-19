import type { Node } from 'three/webgpu';
import { vec3 } from 'three/tsl';

/** Derivative columns of velocity yield curl and symmetric strain in inverse seconds.
 * Uniform translation cancels before this function; rigid rotation contributes curl but no strain. */
export default function liquidVelocityActivity(dx: Node<'vec3'>, dy: Node<'vec3'>, dz: Node<'vec3'>) {
  const shear = vec3(dx.y.add(dy.x), dx.z.add(dz.x), dy.z.add(dz.y)).mul(0.5).toVar();
  const diagonal = vec3(dx.x, dy.y, dz.z);
  return {
    vorticity: vec3(dy.z.sub(dz.y), dz.x.sub(dx.z), dx.y.sub(dy.x)),
    deformation: diagonal.dot(diagonal).add(shear.dot(shear).mul(2)).max(0).sqrt(),
  };
}
