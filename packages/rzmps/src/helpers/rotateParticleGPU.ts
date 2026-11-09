import type { Node } from 'three/webgpu';
import { cos, sin, vec3 } from 'three/tsl';

/** Rotation used by GPU particle renderers and their attached surface patches. */
export default function rotateXYZ(position: Node<'vec3'>, rotation: Node<'vec3'>): Node<'vec3'> {
  const cx = cos(rotation.x);
  const sx = sin(rotation.x);
  const cy = cos(rotation.y);
  const sy = sin(rotation.y);
  const cz = cos(rotation.z);
  const sz = sin(rotation.z);

  const xRotated = vec3(
    position.x,
    position.y.mul(cx).sub(position.z.mul(sx)),
    position.y.mul(sx).add(position.z.mul(cx)),
  );
  const yRotated = vec3(
    xRotated.x.mul(cy).add(xRotated.z.mul(sy)),
    xRotated.y,
    xRotated.z.mul(cy).sub(xRotated.x.mul(sy)),
  );

  return vec3(
    yRotated.x.mul(cz).sub(yRotated.y.mul(sz)),
    yRotated.x.mul(sz).add(yRotated.y.mul(cz)),
    yRotated.z,
  );
}
