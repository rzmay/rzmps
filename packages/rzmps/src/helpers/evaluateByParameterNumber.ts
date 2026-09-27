import type { ValueByParameter } from '../types/ValueByParameter';
import evaluateByParameter from './evaluateByParameter';

export default function evaluateByParameterNumber(
  value: ValueByParameter<number> = 0,
  parameter = 0,
): number {
  return evaluateByParameter<number>(
    value,
    parameter,
    (a, b, t) => a + (b - a) * t,
    (v, t) => v * t,
  );
}
