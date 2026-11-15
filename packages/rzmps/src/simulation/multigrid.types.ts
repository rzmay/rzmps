/** Optional pressure-cycle tuning. Normally the internal defaults are sufficient. */
export interface MultigridOptions {
  /** Fine/coarse smoothing before restriction. Defaults to 2. */
  preSmoothing?: number;
  /** Smoothing after prolongation. Defaults to 4. */
  postSmoothing?: number;
  /** Smoothing at the actual bottom of the usable hierarchy. Defaults to 12. */
  bottomIterations?: number;
}
