import type { Node } from 'three/webgpu';
import { float, positionView } from 'three/tsl';

/** Bounded view-space bump from any procedural height, using the receiving surface's geometric normal. */
export default function perturbNormal(
  height: Node<'float'>,
  normal: Node<'vec3'>,
  strength: Node<'float'> = float(1),
): Node<'vec3'> {
  const dx = positionView.dFdx(),
    dy = positionView.dFdy();
  const tangent = dy.cross(normal),
    bitangent = normal.cross(dx);
  const determinant = dx.dot(tangent);
  const gradient = tangent
    .mul(height.dFdx())
    .add(bitangent.mul(height.dFdy()))
    .mul(determinant.sign())
    .div(determinant.abs().max(1e-6));
  const detail = gradient.div(gradient.length().max(1)).mul(strength.max(0));
  return normal.sub(detail).normalize();
}
