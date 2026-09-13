import * as THREE from 'three';
import { DynamicValue } from '../types/DynamicValue';
import evaluateDynamic from './evaluateDynamic';

export default function evaluateDynamicColor(
  value: DynamicValue<THREE.Color> = new THREE.Color(),
  time = 0,
  seed: string | undefined = undefined,
): THREE.Color {
  return evaluateDynamic<THREE.Color>(
    value,
    (a, b, t) => (a.clone().add((b.clone().sub(a).multiplyScalar(t)))),
    time,
    seed,
  ).clone();
}
