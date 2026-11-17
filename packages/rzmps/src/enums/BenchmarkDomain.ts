/** Origin of a benchmark measurement; value metrics are neither CPU nor GPU elapsed time. */
export enum BenchmarkDomain {
  CPU = 'cpu',
  GPU = 'gpu',
  Value = 'value',
}
