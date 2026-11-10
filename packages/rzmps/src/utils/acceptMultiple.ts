import type { Multiple } from '../types/multiple.types';

export default function acceptMultiple<T>(param?: Multiple<T>) {
  if (!param) return;

  const arr: T[] = [];
  return arr.concat(param).filter((e) => e != null);
}
