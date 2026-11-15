/** Pressure projection strategy. Pressure quality controls are shared by every strategy. */
enum PressureSolver {
  /** Recommended: use only workload regions where multigrid has demonstrated an equal-quality advantage. */
  Auto = 'Auto',
  /** Low-overhead fine-grid smoothing, suitable for smaller systems and unvalidated workload regions. */
  Iterative = 'Iterative',
  /** Force sparse multigrid corrections, including on small supported grids. */
  Multigrid = 'Multigrid',
}

export { PressureSolver };
