import { Vector3 } from 'three';
import type { DynamicValue } from './dynamicValue.types';
import type { Vector3Input } from './valueInput.types';
import acceptVector3 from './acceptVector3';
import sampleDynamicValue from './sampleDynamicValue';

/** Sampled component-wise minimum; unreadable values return a zero vector. Inputs are not mutated. */
export default function minDynamicVector(value: DynamicValue<Vector3Input> = 0, resolution = 16): Vector3 {
  return sampleDynamicValue<Vector3, Vector3Input>(value, (a, b) => a.clone().min(b), resolution,
    leaf => {
      if (typeof leaf !== 'number' && !(leaf instanceof Vector3)) return undefined;
      const vector = acceptVector3(leaf);
      return [vector.x, vector.y, vector.z].every(Number.isFinite) ? vector.clone() : undefined;
    }) ?? new Vector3();
}
