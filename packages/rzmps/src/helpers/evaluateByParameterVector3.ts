import * as THREE from 'three';
import type { Vector3Input } from '../types/ValueInput';
import acceptVector3 from './acceptVector3';
import type { ValueByParameter } from '../types/ValueByParameter';
import evaluateByParameter from './evaluateByParameter';

export default function evaluateByParameterVector3(
  value: ValueByParameter<Vector3Input> = new THREE.Vector3(),
  parameter = 0,
): THREE.Vector3 {
  return evaluateByParameter<THREE.Vector3, Vector3Input>(
    value,
    parameter,
    (a, b, t) => a.clone().lerp(b, t),
    (v, t) => v.clone().multiplyScalar(t),
    acceptVector3,
  );
}
