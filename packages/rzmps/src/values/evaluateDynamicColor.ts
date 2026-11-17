import * as THREE from 'three';
import type { ColorRepresentation } from 'three';
import acceptColor from './acceptColor';
import type { DynamicValue } from './dynamicValue.types';
import evaluateDynamic from './evaluateDynamic';

export default function evaluateDynamicColor(
  value: DynamicValue<ColorRepresentation> = new THREE.Color(),
  time = 0,
  seed: string | undefined = undefined,
): THREE.Color {
  return evaluateDynamic<THREE.Color, ColorRepresentation>(
    value,
    (a, b, t) => (a.clone().add((b.clone().sub(a).multiplyScalar(t)))),
    time,
    seed,
    acceptColor,
  ).clone();
}
