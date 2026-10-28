/** Converts render density into per-cell opacity, without modifying the simulated density. */
export enum VolumeDensityMapping {
  /** Hide the density field. */
  None = 'None',
  /** Smooth threshold/range mapping, preserving the original renderer's appearance controls. */
  Smoothstep = 'Smoothstep',
  /** Linearly map densityRange to zero through one. */
  Linear = 'Linear',
  /** Evaluate densityCurve using densityRange-normalized density. */
  Curve = 'Curve',
}
