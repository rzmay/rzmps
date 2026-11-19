import type Benchmarks from '../../core/Benchmarks';
import type { ComputeNode } from 'three/webgpu';

/** Yield between graph builds and keep a bounded number of asynchronous compilations in flight.
 * Serial driver round-trips can leave the old, expensive tier running for seconds during live growth. */
export default async function prepareComputePrograms(renderer: { backend?: unknown },
  nodes: readonly ComputeNode[], current = () => true, benchmarks?: Benchmarks): Promise<void> {
  const compiler = renderer as {
    compileComputeAsync?: (nodes: ComputeNode[]) => Promise<void>;
  };
  if (!compiler.compileComputeAsync) return;
  const pending = new Set<Promise<void>>();
  let failure: unknown, failed = false;
  for (const node of nodes) {
    await new Promise(resolve => setTimeout(resolve, 0));
    if (!current() || failed) break;
    const preparation = Promise.resolve().then(() => {
      const started = performance.now();
      const family = node.name || 'compute';
      benchmarks?.set(`preparation/active/${family}`, 1);
      const compilation = compiler.compileComputeAsync!([node]);
      if (benchmarks) {
        const cpu = performance.now() - started;
        // Three builds asynchronously after this call. Submission is not graph-build CPU time.
        benchmarks.set(`preparation/submissionMs/${family}`, cpu);
        benchmarks.set('preparationLastBuildAt', started);
        benchmarks.set('preparationActiveCompilers', pending.size);
      }
      return compilation.finally(() => {
        benchmarks?.set(`preparation/active/${family}`, 0);
        benchmarks?.set(`preparation/compileWallMs/${family}`, performance.now() - started);
      });
    }).catch(cause => {
      failed = true; failure = cause;
    });
    pending.add(preparation);
    void preparation.then(() => pending.delete(preparation));
    if (pending.size >= 4) await Promise.race(pending);
  }
  // Even cancellation must settle outstanding users before the caller can retire captured bindings.
  await Promise.all(pending);
  benchmarks?.set('preparationActiveCompilers', 0);
  if (failed) throw failure;
}
