import * as THREE from 'three';
import type { Vector3Input } from '../types/ValueInput';
import acceptVector3 from './acceptVector3';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamic from './evaluateDynamic';

export default function evaluateDynamicVector(
  value: DynamicValue<Vector3Input> = new THREE.Vector3(),
  time = 0,
  seed: string | undefined = undefined,
): THREE.Vector3 {
  return evaluateDynamic<THREE.Vector3, Vector3Input>(
    value,
    (a, b, t) => (a.clone().add((b.clone().sub(a).multiplyScalar(t)))),
    time,
    seed,
    acceptVector3,
  );
}
