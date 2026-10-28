/** Reconstruction used when sampling volume voxels, independently of simulation advection. */
export enum VolumeInterpolation {
  /** Sample the closest voxel without smoothing. */
  Nearest = 'Nearest',
  /** Interpolate the eight neighboring voxels. This is the default. */
  Linear = 'Linear',
  /** Smooth cubic B-spline reconstruction over neighboring voxels; costs more texture reads. */
  Cubic = 'Cubic',
}
