import type { DynamicValue } from './dynamicValue.types';
import sampleDynamicValue from './sampleDynamicValue';

/** Sampled numeric maximum, including negative values. Unreadable values use fallback (default zero). */
export default function maxDynamicNumber(value: DynamicValue<number> = 0, resolution = 16, fallback = 0): number {
  return sampleDynamicValue(value, Math.max, resolution,
    leaf => typeof leaf === 'number' && Number.isFinite(leaf) ? leaf : undefined) ?? fallback;
}
