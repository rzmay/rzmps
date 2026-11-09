import type { DynamicValue } from '../types/DynamicValue';
import maxDynamicNumber from './maxDynamicNumber';

/** Nonnegative sampled maximum used for predictive resource allocation. Opaque TSL returns zero. */
export default function maximumDynamicNumber(value: DynamicValue<number>, resolution = 16): number {
  return Math.max(0, maxDynamicNumber(value, resolution));
}
