import { DynamicValue } from '../types/DynamicValue';
import evaluateDynamic from './evaluateDynamic';

export default function evaluateDynamicNumber(
  value: DynamicValue<number> = 0,
  time = 0,
  seed: string | undefined = undefined,
): number {
  return evaluateDynamic<number>(
    value,
    (a, b, t) => (a + (b - a) * t),
    time,
    seed,
  );
}
