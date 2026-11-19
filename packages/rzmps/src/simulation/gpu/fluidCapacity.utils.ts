import type { Vector3 } from 'three';

/** A pool cannot use more pages than physically fit inside its configured domain ceiling.
 * Round to the ordinary geometric tier, retaining native limits and unbounded-domain behavior. */
export function maximumFluidResidentCapacity(maximumBounds: Vector3, brickSize: number, nativeMaximum: number): number {
  const dimensions = maximumBounds.toArray();
  if (dimensions.some(value => !Number.isFinite(value))) return nativeMaximum;
  const pages = dimensions.reduce((product, value) => product * Math.max(1, Math.floor(value / brickSize + 1e-6)), 1);
  return Math.min(nativeMaximum, 2 ** Math.ceil(Math.log2(Math.max(1, pages))));
}

/** Reserve a conservative nested-lattice refinement before discarding the old mapping. */
export function refinementResidentCapacity(
  current: number,
  resident: number,
  ratio: number,
  logicalPages: number,
  maximum: number,
): number {
  const required = Math.ceil(Math.min(logicalPages, resident * Math.max(1, ratio) ** 3));
  if (required > maximum) throw new RangeError('Refined liquid support exceeds available resident storage.');
  return Math.min(maximum, 2 ** Math.ceil(Math.log2(Math.max(1, Math.min(current, maximum), required))));
}

/** Count coarser receiver positions from actual resident support, including one target-brick ring.
 * This runs only during background tier preparation; it does not admit pages or allocate empty cells. */
export function coarsenedResidentCapacity(
  slots: Uint32Array,
  sourceDimensions: Vector3,
  sourceMinimum: Vector3,
  sourceBrick: number,
  targetDimensions: Vector3,
  targetMinimum: Vector3,
  targetBrick: number,
  maximum: number,
): number {
  const requested = new Set<number>();
  const source = sourceDimensions.toArray(),
    target = targetDimensions.toArray();
  const lower = sourceMinimum.toArray(),
    origin = targetMinimum.toArray();
  for (const address of slots) {
    if (!address) continue;
    const index = address - 1;
    const coordinate = [
      index % source[0],
      Math.floor(index / source[0]) % source[1],
      Math.floor(index / (source[0] * source[1])),
    ];
    const low = coordinate.map((value, axis) =>
      Math.max(0, Math.floor((lower[axis] + value * sourceBrick - origin[axis]) / targetBrick) - 1),
    );
    const high = coordinate.map((value, axis) =>
      Math.min(
        target[axis] - 1,
        Math.floor((lower[axis] + (value + 1) * sourceBrick - origin[axis] - 1e-6) / targetBrick) + 1,
      ),
    );
    for (let z = low[2]; z <= high[2]; z++)
      for (let y = low[1]; y <= high[1]; y++) {
        for (let x = low[0]; x <= high[0]; x++) requested.add(x + target[0] * (y + target[1] * z));
      }
  }
  if (requested.size > maximum) throw new RangeError('Coarsened liquid support exceeds available resident storage.');
  return Math.min(maximum, 2 ** Math.ceil(Math.log2(Math.max(1, requested.size))));
}
