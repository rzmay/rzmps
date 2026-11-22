import type { DynamicValue } from '../values/dynamicValue.types';
import isTSLNode from '../utils/isTSLNode';

/** Normalize numeric inputs that volume copies and appearance curves evaluate on the CPU. */
export default function volumeNumber(value: DynamicValue<number>): DynamicValue<number> {
  if (isTSLNode(value)) {
    const node = value as unknown as { value?: unknown; isVarNode?: boolean; node?: DynamicValue<number> };
    const literal = node.value;
    if (typeof literal === 'number') return literal;
    if (node.isVarNode && node.node && isTSLNode(node.node)) return volumeNumber(node.node);
    throw new Error('Volume appearance requires CPU-evaluable curves or numeric TSL constants/uniforms.');
  }

  if (typeof value === 'function') return t => volumeNumber(value(t));
  if (Array.isArray(value)) return [volumeNumber(value[0]), volumeNumber(value[1])];
  if (value instanceof Set) return new Set([...value].map(volumeNumber));

  return value;
}
