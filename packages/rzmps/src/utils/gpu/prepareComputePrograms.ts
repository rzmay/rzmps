import type { ComputeNode } from 'three/webgpu';

/** Prepare one compute program at a time, yielding without submitting simulation dispatches. */
export default async function prepareComputePrograms(renderer: { backend?: unknown },
  nodes: readonly ComputeNode[], current = () => true): Promise<void> {
  const compiler = renderer as {
    compileComputeAsync?: (nodes: ComputeNode[]) => Promise<void>;
  };
  if (!compiler.compileComputeAsync) return;
  for (const node of nodes) {
    await new Promise(resolve => setTimeout(resolve, 0));
    if (!current()) return;
    await compiler.compileComputeAsync([node]);
  }
}
