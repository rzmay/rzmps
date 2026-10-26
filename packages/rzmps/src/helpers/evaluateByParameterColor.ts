import * as THREE from 'three';
import type { ColorInput } from '../types/ValueInput';
import acceptColor from './acceptColor';
import type { ValueByParameter } from '../types/ValueByParameter';
import evaluateByParameter from './evaluateByParameter';

export default function evaluateByParameterColor(
  value: ValueByParameter<ColorInput> = new THREE.Color(),
  parameter = 0,
): THREE.Color {
  return evaluateByParameter<THREE.Color, ColorInput>(
    value,
    parameter,
    (a, b, t) => a.clone().lerp(b, t),
    (v, t) => v.clone().multiplyScalar(t),
    acceptColor,
  );
}
