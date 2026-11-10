import type { DynamicValue } from './dynamicValue.types';
import sampleDynamicValue from './sampleDynamicValue';

/** Sampled numeric minimum. Unreadable values use fallback (default zero). */
export default function minDynamicNumber(value: DynamicValue<number> = 0, resolution = 16, fallback = 0): number {
  return sampleDynamicValue(value, Math.min, resolution,
    leaf => typeof leaf === 'number' && Number.isFinite(leaf) ? leaf : undefined) ?? fallback;
}
