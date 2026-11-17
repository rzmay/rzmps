import { Color } from 'three';
import type { ColorRepresentation } from 'three';

export default function acceptColor(value: ColorRepresentation): Color {
  return value instanceof Color ? value : new Color(value);
}
