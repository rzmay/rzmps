import type { Node } from 'three/webgpu';

/** Compress noise coordinates along flow, matching liquid distortion without changing simulation state. */
export default function stretchAlongVelocity(point: Node<'vec3'>, velocity: Node<'vec3'>,
  amount: Node<'float'>, speed: Node<'float'> = velocity.length()): Node<'vec3'> {
  const direction = velocity.div(speed.max(0.01));
  return point.sub(direction.mul(point.dot(direction)).mul(amount.clamp(0, 0.95)));
}
