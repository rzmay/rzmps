/** Particle property affected by a noise transform. */
export enum TransformMode {
  /** Add a position offset directly; use transient priority for non-accumulating render-time detail. */
  Position = 'Position',
  /** Add noise times delta seconds to velocity, preserving the default TransformByNoise behavior. */
  Velocity = 'Velocity',
  /** Add a force divided by particle mass to acceleration, integrated by ordinary particle motion. */
  Force = 'Force',
}
