function describe(error) {
  return typeof error === 'string' ? error : `${error?.name ?? ''}: ${error?.message ?? String(error)}`;
}

export function isExpectedWebGPUTeardownError(error) {
  const description = describe(error);
  return description.includes('OperationError') && description.includes('Instance dropped in popErrorScope');
}

/** Retry device/driver failures, never shader validation errors or genuinely oversized allocations. */
export function isRetryableBenchmarkError(error) {
  const description = describe(error);
  if (/GPUValidationError|Compute pipeline creation failed/.test(description)) return false;
  if (/WebGPU.*Device Lost|WebGPU device lost/i.test(description)) return true;
  if (isExpectedWebGPUTeardownError(error)) return true;

  const allocation = description.match(
    /createBuffer failed, size \((\d+)\) is too large for the implementation when mappedAtCreation == true/,
  );
  return Boolean(allocation && Number(allocation[1]) > 0 && Number(allocation[1]) <= 64 * 1024);
}

/** Discard the whole failed sample; the callback must own and close a fresh browser per attempt. */
export async function runBenchmarkWithRetry(run, onRetry) {
  try {
    return await run(1);
  } catch (error) {
    if (!isRetryableBenchmarkError(error)) throw error;

    onRetry?.(error);
    return run(2);
  }
}


/** A Node deadline also expires when the browser's own JavaScript/event loop is stuck. */
export async function withBenchmarkTimeout(operation, timeoutMs, stage) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${stage} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Attempt every cleanup step and preserve the primary measurement error. */
export async function cleanupBenchmark(steps, primaryError, onError = () => {}) {
  let firstError;
  for (const { name, run } of steps) {
    try { await run(); }
    catch (error) {
      firstError ??= error;
      onError(name, error);
    }
  }
  if (!primaryError && firstError) throw firstError;
}
