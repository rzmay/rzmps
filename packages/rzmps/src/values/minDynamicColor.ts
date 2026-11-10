import { Color } from 'three';
import type { DynamicValue } from './dynamicValue.types';
import type { ColorInput } from './valueInput.types';
import acceptColor from './acceptColor';
import sampleDynamicValue from './sampleDynamicValue';

/** Sampled component-wise minimum in working color space; unreadable values return black. Inputs are not mutated. */
export default function minDynamicColor(value: DynamicValue<ColorInput> = 0, resolution = 16): Color {
  return sampleDynamicValue<Color, ColorInput>(value,
    (a, b) => new Color(Math.min(a.r, b.r), Math.min(a.g, b.g), Math.min(a.b, b.b)),
    resolution, leaf => {
      if (typeof leaf !== 'string' && typeof leaf !== 'number' && !(leaf instanceof Color)) return undefined;
      if (typeof leaf === 'number' && !Number.isFinite(leaf)) return undefined;
      const color = acceptColor(leaf);
      return [color.r, color.g, color.b].every(Number.isFinite) ? color.clone() : undefined;
    }) ?? new Color(0, 0, 0);
}
