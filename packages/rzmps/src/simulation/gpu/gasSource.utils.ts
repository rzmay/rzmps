import type { Node } from 'three/webgpu';
import { clamp, float, max } from 'three/tsl';

/** Integral of a unit-mass tent from negative infinity to a normalized coordinate. */
function tentIntegral(coordinate: Node<'float'>): Node<'float'> {
  const left = clamp(coordinate.add(1), 0, 1);
  const right = clamp(float(1).sub(coordinate), 0, 1);
  return coordinate.lessThan(0).select(left.mul(left).mul(0.5), float(1).sub(right.mul(right).mul(0.5)));
}

/** Cell-averaged concentration per unit emitted mass; the voxel integrals partition unity. */
export function gasSourceWeight(center: Node<'vec3'>, position: Node<'vec3'>,
  scale: Node<'vec3'>, cellWidth: Node<'float'>): Node<'float'> {
  // Integrating the physical footprint keeps even sub-cell sources conservative at every grid phase.
  const radius = max(max(scale.x.abs(), max(scale.y.abs(), scale.z.abs())).mul(0.5), 1e-6);
  const offset = center.sub(position);
  const fractions = (['x', 'y', 'z'] as const).map(axis => {
    const upper = tentIntegral(offset[axis].add(cellWidth.mul(0.5)).div(radius));
    const lower = tentIntegral(offset[axis].sub(cellWidth.mul(0.5)).div(radius));
    return max(upper.sub(lower), 0);
  });

  return fractions[0].mul(fractions[1]).mul(fractions[2]).div(cellWidth.pow(3));
}

/** The separable footprint's corners and intersecting voxel centers must fit the spherical query. */
export function gasSourceQueryRadius(particleRadius: Node<'float'>, cellWidth: Node<'float'>): Node<'float'> {
  return particleRadius.add(cellWidth.mul(0.5)).mul(Math.sqrt(3));
}
