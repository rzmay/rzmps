import type { ValueByParameter } from '../types/ValueByParameter';
import isTSLNode from './isTSLNode';

export default function evaluateByParameter<T>(
  value: ValueByParameter<T>,
  parameter: number,
  interpolate: (a: T, b: T, t: number) => T,
  scale: (value: T, t: number) => T,
): T {
  if (isTSLNode(value)) {
    throw new Error('TSL nodes can only be used during GPU processing.');
  }

  if (typeof value === 'function') {
    const result = (value as ((t: number) => ValueByParameter<T>))(parameter);

    if (typeof result === 'function' || Array.isArray(result)) {
      return evaluateByParameter(result, parameter, interpolate, scale);
    }

    return result as T;
  }

  if (Array.isArray(value)) {
    const min = resolveEndpoint(value[0], parameter, interpolate, scale);
    const max = resolveEndpoint(value[1], parameter, interpolate, scale);

    return interpolate(min, max, parameter);
  }

  return scale(value as T, parameter);
}

function resolveEndpoint<T>(
  value: ValueByParameter<T>,
  parameter: number,
  interpolate: (a: T, b: T, t: number) => T,
  scale: (value: T, t: number) => T,
): T {
  if (isTSLNode(value)) {
    throw new Error('TSL nodes can only be used during GPU processing.');
  }

  if (typeof value === 'function') {
    const result = (value as ((t: number) => ValueByParameter<T>))(parameter);

    if (typeof result === 'function' || Array.isArray(result)) {
      return evaluateByParameter(result, parameter, interpolate, scale);
    }

    return result as T;
  }

  if (Array.isArray(value)) {
    return evaluateByParameter(value, parameter, interpolate, scale);
  }

  return value as T;
}
