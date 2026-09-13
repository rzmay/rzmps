import * as THREE from 'three';
import { DynamicValue } from '../types/DynamicValue';
import evaluateDynamic from './evaluateDynamic';

export default function evaluateDynamicVector(
  value: DynamicValue<THREE.Vector3> = new THREE.Vector3(),
  time = 0,
  seed: string | undefined = undefined,
): THREE.Vector3 {
  return evaluateDynamic<THREE.Vector3>(
    value,
    (a, b, t) => (a.clone().add((b.clone().sub(a).multiplyScalar(t)))),
    time,
    seed,
  );
}
