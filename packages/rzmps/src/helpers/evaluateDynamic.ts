import type { DynamicValue } from '../types/DynamicValue';
import seedrandom from 'seedrandom';
import isTSLNode from './isTSLNode';

export default function evaluateDynamic<T, Input = T>(
  value: DynamicValue<Input>,
  interpolate: (a: T, b: T, t: number) => T,
  time = 0,
  seed: string | undefined = undefined,
  accept: (value: Input) => T = (value) => value as unknown as T,
): T {
  if (isTSLNode(value)) {
    throw new Error('TSL nodes can only be used during GPU processing.');
  }

  if (typeof value === 'function') {
    return evaluateDynamic((value as (t: number) => DynamicValue<Input>)(time), interpolate, time, seed, accept);
  } else if (Array.isArray(value)) {
    const interpTime = seed == undefined ? Math.random() : seedrandom(seed).quick();

    const min: T = evaluateDynamic(value[0], interpolate, time, seed, accept);
    const max: T = evaluateDynamic(value[1], interpolate, time, seed, accept);

    return interpolate(min, max, interpTime);
  } else if (value instanceof Set) {
    const indexSelector = seed == undefined ? Math.random() : seedrandom(seed).quick();
    const item =  Array.from(value)[Math.floor(value.size * indexSelector)];

    return evaluateDynamic(item, interpolate, time, seed, accept);
  }
  return accept(value as Input);
}
