import { Color } from 'three';
import type { ColorInput } from './valueInput.types';

export default function acceptColor(value: ColorInput): Color {
  return value instanceof Color ? value : new Color(value);
}
