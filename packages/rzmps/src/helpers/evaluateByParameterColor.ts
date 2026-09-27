import * as THREE from 'three';
import type { ValueByParameter } from '../types/ValueByParameter';
import evaluateByParameter from './evaluateByParameter';

export default function evaluateByParameterColor(
  value: ValueByParameter<THREE.Color> = new THREE.Color(),
  parameter = 0,
): THREE.Color {
  return evaluateByParameter<THREE.Color>(
    value,
    parameter,
    (a, b, t) => a.clone().lerp(b, t),
    (v, t) => v.clone().multiplyScalar(t),
  );
}
