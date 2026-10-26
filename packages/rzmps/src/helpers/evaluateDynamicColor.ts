import * as THREE from 'three';
import type { ColorInput } from '../types/ValueInput';
import acceptColor from './acceptColor';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamic from './evaluateDynamic';

export default function evaluateDynamicColor(
  value: DynamicValue<ColorInput> = new THREE.Color(),
  time = 0,
  seed: string | undefined = undefined,
): THREE.Color {
  return evaluateDynamic<THREE.Color, ColorInput>(
    value,
    (a, b, t) => (a.clone().add((b.clone().sub(a).multiplyScalar(t)))),
    time,
    seed,
    acceptColor,
  ).clone();
}
