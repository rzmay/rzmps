import type { ValueByParameter } from '../types/ValueByParameter';
import isTSLNode from './isTSLNode';

export default function evaluateByParameter<T, Input = T>(
  value: ValueByParameter<Input>,
  parameter: number,
  interpolate: (a: T, b: T, t: number) => T,
  scale: (value: T, t: number) => T,
  accept: (value: Input) => T = (value) => value as unknown as T,
): T {
  if (isTSLNode(value)) {
    throw new Error('TSL nodes can only be used during GPU processing.');
  }

  if (typeof value === 'function') {
    const result = (value as (t: number) => ValueByParameter<Input>)(parameter);

    if (typeof result === 'function' || Array.isArray(result)) {
      return evaluateByParameter(result, parameter, interpolate, scale, accept);
    }

    return accept(result as Input);
  }

  if (Array.isArray(value)) {
    const min = resolveEndpoint(value[0], parameter, interpolate, scale, accept);
    const max = resolveEndpoint(value[1], parameter, interpolate, scale, accept);

    return interpolate(min, max, parameter);
  }

  return scale(accept(value as Input), parameter);
}

function resolveEndpoint<T, Input>(
  value: ValueByParameter<Input>,
  parameter: number,
  interpolate: (a: T, b: T, t: number) => T,
  scale: (value: T, t: number) => T,
  accept: (value: Input) => T,
): T {
  if (isTSLNode(value)) {
    throw new Error('TSL nodes can only be used during GPU processing.');
  }

  if (typeof value === 'function') {
    const result = (value as (t: number) => ValueByParameter<Input>)(parameter);

    if (typeof result === 'function' || Array.isArray(result)) {
      return evaluateByParameter(result, parameter, interpolate, scale, accept);
    }

    return accept(result as Input);
  }

  if (Array.isArray(value)) {
    return evaluateByParameter(value, parameter, interpolate, scale, accept);
  }

  return accept(value as Input);
}
