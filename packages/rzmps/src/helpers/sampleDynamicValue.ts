import type { DynamicValue } from '../types/DynamicValue';
import isTSLNode from './isTSLNode';

/**
 * Reduces dynamic leaves with a caller-supplied function. Ranges visit both endpoints;
 * sets visit every member; functions sample normalized time from zero through one.
 * Function results are approximate. Constant node values are inspected without GPU
 * work; opaque nodes, cyclic/deep branches, and throwing samples are skipped.
 * Returns undefined when no readable leaf is available. An accept callback can
 * normalize inputs and reject leaves by returning undefined.
 */
export default function sampleDynamicValue<T>(
  value: DynamicValue<T>, sample: (a: T, b: T) => T, resolution?: number,
): T | undefined;
export default function sampleDynamicValue<T, Input>(
  value: DynamicValue<Input>, sample: (a: T, b: T) => T, resolution: number,
  accept: (value: Input) => T | undefined,
): T | undefined;
export default function sampleDynamicValue<T, Input = T>(
  value: DynamicValue<Input>,
  sample: (a: T, b: T) => T,
  resolution = 16,
  accept: (value: Input) => T | undefined = value => value as unknown as T,
): T | undefined {
  const samples = Number.isFinite(resolution) ? Math.max(2, Math.floor(resolution)) : 16;
  const active = new Set<unknown>();
  let result: T | undefined;

  const visit = (current: DynamicValue<Input>, depth: number): void => {
    if (depth > 8 || active.has(current)) return;
    const branch = typeof current === 'function' || Array.isArray(current)
      || current instanceof Set || isTSLNode(current);
    if (branch) active.add(current);
    try {
      if (typeof current === 'function') {
        for (let index = 0; index < samples; index += 1) {
          let next: DynamicValue<Input>;
          try { next = (current as (t: number) => DynamicValue<Input>)(index / (samples - 1)); }
          catch { continue; }
          visit(next, depth + 1);
        }
      } else if (Array.isArray(current) || current instanceof Set) {
        for (const next of current) visit(next, depth + 1);
      } else if (isTSLNode(current)) {
        const node = current as { value?: DynamicValue<Input>;
          node?: { isConstNode?: boolean; value?: DynamicValue<Input> } };
        const constant = node.value ?? (node.node?.isConstNode ? node.node.value : undefined);
        if (constant !== undefined) visit(constant, depth + 1);
      } else {
        const leaf = accept(current as Input);
        if (leaf !== undefined) result = result === undefined ? leaf : sample(result, leaf);
      }
    } finally {
      if (branch) active.delete(current);
    }
  };

  visit(value, 0);
  return result;
}
