import * as THREE from 'three';
import type { ValueByParameter } from '../types/ValueByParameter';
import evaluateByParameter from './evaluateByParameter';

export default function evaluateByParameterVector3(
  value: ValueByParameter<THREE.Vector3> = new THREE.Vector3(),
  parameter = 0,
): THREE.Vector3 {
  return evaluateByParameter<THREE.Vector3>(
    value,
    parameter,
    (a, b, t) => a.clone().lerp(b, t),
    (v, t) => v.clone().multiplyScalar(t),
  );
}
