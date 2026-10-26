import { Vector3 } from 'three';
import type { Vector3Input } from '../types/ValueInput';

export default function acceptVector3(value: Vector3Input): Vector3 {
  return typeof value === 'number' ? new Vector3(value, value, value) : value;
}
