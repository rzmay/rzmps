import { Multiple } from '../types/Multiple';

export default function acceptMultiple<T>(param?: Multiple<T>) {
  if (!param) return;

  const arr: T[] = [];
  return arr.concat(param).filter((e) => e != null);
}
