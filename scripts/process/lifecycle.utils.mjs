/** Bound Node-side operations even when a browser or its event loop stops responding. */
export async function withDeadline(operation, timeoutMs, stage) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${stage} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Run every cleanup step and retain the original failure instead of masking it with teardown errors. */
export async function cleanupSteps(steps, primaryError, onError = () => {}) {
  let firstError;
  for (const { name, run } of steps) {
    try {
      await run();
    } catch (error) {
      firstError ??= error;
      onError(name, error);
    }
  }
  if (!primaryError && firstError) throw firstError;
}

export async function closeBrowser(browser, timeoutMs) {
  if (!browser) return;
  try {
    await withDeadline(() => browser.close(), timeoutMs, 'Closing browser');
  } catch (error) {
    browser.process()?.kill('SIGKILL');
    throw error;
  }
}
