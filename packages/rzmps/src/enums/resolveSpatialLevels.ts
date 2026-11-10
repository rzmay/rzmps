/** Optional maintained grid resolutions, relative to the brick/cell subdivision boundary. */
export enum SpatialLevels {
  /** Keep only the mandatory finest neighbor index. */
  None = 'none',

  /** Keep depths zero through brickSubdivisions, and the finest index. */
  Bricks = 'bricks',

  /** Keep depths brickSubdivisions through maxDepth. */
  Cells = 'cells',

  /** Keep every depth from zero through maxDepth. */
  All = '*',
}

export type SpatialLevelsInput = readonly number[] | SpatialLevels | `${SpatialLevels}` | keyof typeof SpatialLevels;

export interface SpatialGridOptions {
  levels?: SpatialLevelsInput;
}

/** Resolves enum keys/values and explicit depths; the finest index is always retained. */
export function resolveSpatialLevels(input: SpatialLevelsInput | undefined, bricks: number, cells: number): number[] {
  const maximum = bricks + cells;
  const depths = new Set<number>([maximum]);

  if (Array.isArray(input)) {
    input.forEach(depth => {
      if (!Number.isInteger(depth) || depth < 0 || depth > maximum) {
        throw new RangeError(`Spatial depth must be an integer from 0 through ${maximum}.`);
      }
      depths.add(depth);
    });
  } else {
    const preset = input === undefined ? SpatialLevels.None
      : Object.prototype.hasOwnProperty.call(SpatialLevels, String(input))
        ? SpatialLevels[input as keyof typeof SpatialLevels] : input;
    let start = 0;
    let end = -1;

    switch (preset) {
      case SpatialLevels.None:
        break;
      case SpatialLevels.Bricks:
        end = bricks;
        break;
      case SpatialLevels.Cells:
        start = bricks;
        end = maximum;
        break;
      case SpatialLevels.All:
        end = maximum;
        break;
      default:
        throw new RangeError(`Unknown spatial levels preset: ${String(input)}.`);
    }

    for (let depth = start; depth <= end; depth++) depths.add(depth);
  }

  return [...depths].sort((a, b) => a - b);
}
