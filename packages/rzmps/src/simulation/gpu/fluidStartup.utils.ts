/** Use one normal tier finer than uncertain predicted coverage, within the configured quality policy. */
export function initialFluidQuality(extent: number, minimum: number, maximum: number): number {
  if (!(extent > 0) || !Number.isFinite(extent)) return minimum;
  return Math.min(maximum, Math.max(minimum, 2 ** (Math.ceil(Math.log2(extent)) - 1)));
}
