import type { DynamicValue } from './dynamicValue.types';
import sampleDynamicValue from './sampleDynamicValue';

/** Median of readable numeric leaves, averaging the central pair for even counts. Functions sample uniform time.
 * Ranges visit endpoints and sets visit members; this is not a conservative bound. Unreadable values use fallback.
 */
export default function medianDynamicNumber(value: DynamicValue<number> = 0, resolution = 16, fallback = 0): number {
  const samples: number[] = [];
  sampleDynamicValue(value, (_previous, next) => next, resolution, leaf => {
    if (typeof leaf !== 'number' || !Number.isFinite(leaf)) return undefined;
    samples.push(leaf);
    return leaf;
  });
  if (!samples.length) return fallback;
  samples.sort((a, b) => a - b);
  const middle = Math.floor(samples.length / 2);
  return samples.length % 2 ? samples[middle] : samples[middle - 1] / 2 + samples[middle] / 2;
}
