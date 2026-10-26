import { Color } from 'three';
import type { ColorInput } from '../types/ValueInput';

export default function acceptColor(value: ColorInput): Color {
  return value instanceof Color ? value : new Color(value);
}
