import type { DynamicValue } from './dynamicValue.types';
import sampleDynamicValue from './sampleDynamicValue';

/** Arithmetic mean of readable numeric leaves. Functions sample uniform normalized time; ranges visit endpoints.
 * This is a sampled estimate, not a probability-weighted expectation. Unreadable values use fallback (zero).
 */
export default function averageDynamicNumber(value: DynamicValue<number> = 0, resolution = 16, fallback = 0): number {
  let count = 0;
  return sampleDynamicValue(value, (mean, next) => mean * ((count - 1) / count) + next / count, resolution, leaf => {
    if (typeof leaf !== 'number' || !Number.isFinite(leaf)) return undefined;
    count++;
    return leaf;
  }) ?? fallback;
}
