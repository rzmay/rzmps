import type { Node } from 'three/webgpu';
import { float, floor, fract, sin, vec3 } from 'three/tsl';

/** Oblique spatial scrambling plus an irrational per-stratum rotation; no screen or frame seed. */
export function volumeJitter(point: Node<'vec3'>, index: Node<'float'>, seed: Node<'float'>): Node<'float'> {
  const cell = floor(vec3(point.dot(vec3(0.7548777, 0.5698403, 0.438289)),
    point.dot(vec3(-0.438289, 0.7548777, 0.5698403)),
    point.dot(vec3(0.5698403, -0.438289, 0.7548777))).mul(16));
  const rotation = fract(sin(cell.dot(vec3(12.9898, 78.233, 37.719)).add(seed.mul(19.19))).mul(43758.5453));
  return fract(rotation.add(index.mul(0.61803398875)).add(float(0.5)));
}
