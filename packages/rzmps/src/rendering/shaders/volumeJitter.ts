import type { Node } from 'three/webgpu';
import { fract } from 'three/tsl';

/** Full-stratum low-discrepancy offsets from one spatially distributed phase per camera ray. */
export function volumeJitter(rotation: Node<'float'>, index: Node<'float'>): Node<'float'> {
  return fract(rotation.add(index.mul(0.61803398875)));
}
