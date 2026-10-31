import type { DynamicValue } from '../types/DynamicValue';

/** Shared conservative sampling used for predictive resource allocation. Opaque TSL returns zero. */
export default function maximumDynamicNumber(value: DynamicValue<number>, resolution = 16, depth = 0): number {
  if (depth > 8) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, value) : 0;
  if (Array.isArray(value)) return Math.max(0, ...value.map(item => maximumDynamicNumber(item, resolution, depth + 1)));
  if (value instanceof Set) return Math.max(0, ...Array.from(value, item => maximumDynamicNumber(item, resolution, depth + 1)));
  if (typeof value === 'function') {
    let maximum = 0;
    const samples = Math.max(2, Math.floor(resolution));
    for (let i = 0; i < samples; i++) {
      try { maximum = Math.max(maximum, maximumDynamicNumber(value(i / (samples - 1)), resolution, depth + 1)); }
      catch { return maximum; }
    }
    return maximum;
  }
  const node = value as { isNode?: boolean; value?: unknown };
  return node?.isNode && typeof node.value === 'number' ? maximumDynamicNumber(node.value, resolution, depth + 1) : 0;
}
