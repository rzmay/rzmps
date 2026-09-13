import { DynamicValue } from '../types/DynamicValue';
import seedrandom from 'seedrandom';

type SeededMinMax<T> = DynamicValue<T>[] & { _dynamicValueSeededInterp: number };

export default function evaluateDynamic<T>(
  value: DynamicValue<T>,
  interpolate: (a: T, b: T, t: number) => T,
  time = 0,
  seed: string | undefined = undefined,
): T {
  if (typeof value === 'function') {
    return evaluateDynamic((value as ((t: number) => T))(time), interpolate, time, seed);
  } else if (Array.isArray(value)) {
    const interpTime = seed == undefined ? Math.random() : seedrandom(seed).quick();

    const min: T = evaluateDynamic(value[0], interpolate, time, seed);
    const max: T = evaluateDynamic(value[1], interpolate, time, seed);

    return interpolate(min, max, interpTime);
  } else if (value instanceof Set) {
    const indexSelector = seed == undefined ? Math.random() : seedrandom(seed).quick();
    const item =  Array.from(value)[Math.floor(value.size * indexSelector)];

    return evaluateDynamic(item, interpolate, time, seed);
  }
  return value as T;
}
