import type { Matrix4 } from 'three';
import type { Node } from 'three/webgpu';
import { cos, sin, float, vec3, vec4 } from 'three/tsl';

/** Transforms a point using a shader matrix, including its translation. */
export function transformPointGPU(point: Node<'vec3'>, matrix: Node<'mat4'>): Node<'vec3'> {
  return matrix.mul(vec4(point, 1)).xyz as Node<'vec3'>;
}

/** Transforms a direction using a shader matrix, excluding its translation. */
export function transformDirectionGPU(vector: Node<'vec3'>, matrix: Node<'mat4'>): Node<'vec3'> {
  return matrix.mul(vec4(vector, 0)).xyz as Node<'vec3'>;
}

/** Applies XYZ Euler rotation to a shader vector. */
export function rotateXYZ(position: Node<'vec3'>, rotation: Node<'vec3'>): Node<'vec3'> {
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

/** Transforms a point using a CPU matrix embedded in the shader graph. */
export function transformPointMatrixGPU(point: Node<'vec3'>, matrix: Matrix4): Node<'vec3'> {
  const e = matrix.elements;

  return vec3(
    point.x.mul(e[0]).add(point.y.mul(e[4])).add(point.z.mul(e[8])).add(e[12]),
    point.x.mul(e[1]).add(point.y.mul(e[5])).add(point.z.mul(e[9])).add(e[13]),
    point.x.mul(e[2]).add(point.y.mul(e[6])).add(point.z.mul(e[10])).add(e[14]),
  ) as Node<'vec3'>;
}

/** Transforms a direction using a CPU matrix embedded in the shader graph. */
export function transformDirectionMatrixGPU(vector: Node<'vec3'>, matrix: Matrix4): Node<'vec3'> {
  const e = matrix.elements;

  return vec3(
    vector.x.mul(e[0]).add(vector.y.mul(e[4])).add(vector.z.mul(e[8])),
    vector.x.mul(e[1]).add(vector.y.mul(e[5])).add(vector.z.mul(e[9])),
    vector.x.mul(e[2]).add(vector.y.mul(e[6])).add(vector.z.mul(e[10])),
  ) as Node<'vec3'>;
}

export function rotateEulerYXZGPU(vector: Node<'vec3'>, rotation: Node<'vec3'>): Node<'vec3'> {
  const a = cos(rotation.x);
  const b = sin(rotation.x);
  const c = cos(rotation.y);
  const d = sin(rotation.y);
  const e = cos(rotation.z);
  const f = sin(rotation.z);

  return vec3(
    vector.x.mul(c.mul(e).add(d.mul(b).mul(f)))
      .add(vector.y.mul(c.mul(f).negate().add(d.mul(b).mul(e))))
      .add(vector.z.mul(d.mul(a))),
    vector.x.mul(a.mul(f))
      .add(vector.y.mul(a.mul(e)))
      .sub(vector.z.mul(b)),
    vector.x.mul(d.mul(e).negate().add(c.mul(b).mul(f)))
      .add(vector.y.mul(d.mul(f).add(c.mul(b).mul(e))))
      .add(vector.z.mul(c.mul(a))),
  ) as Node<'vec3'>;
}

export function rotateFromYGPU(vector: Node<'vec3'>, direction: Node<'vec3'>): Node<'vec3'> {
  const target = direction.normalize();
  const quaternionVector = vec3(target.z, 0, target.x.negate());
  const quaternionScalar = float(1).add(target.y);
  const inverseLength = quaternionVector.lengthSq().add(quaternionScalar.mul(quaternionScalar))
    .max(float(Number.EPSILON))
    .sqrt()
    .reciprocal();
  const qVector = quaternionVector.mul(inverseLength);
  const qScalar = quaternionScalar.mul(inverseLength);
  const rotated = vector.add(qVector.cross(qVector.cross(vector).add(vector.mul(qScalar))).mul(2));
  const antiparallel = vec3(vector.x, vector.y.negate(), vector.z.negate());

  return target.y.lessThan(-0.9999).select(antiparallel, rotated) as Node<'vec3'>;
}
