import { type ComputeNode, type IndirectStorageBufferAttribute, type Node } from 'three/webgpu';
import { Fn, If, instanceIndex, storage } from 'three/tsl';

/** GPU-produced element count and its caller-owned indirect dispatch arguments. */
export interface GPUComputeRange {
  count: Node<'uint'>;
  dispatch: IndirectStorageBufferAttribute;
}

/** Emits command writes inside a caller's existing scheduling pass; no readback or extra submission. */
export function writeComputeDispatch(range: GPUComputeRange, workgroupSize = 64): void {
  const args = storage(range.dispatch, 'uint', 3);
  args.element(0).assign(range.count.add(workgroupSize - 1).div(workgroupSize));
  args.element(1).assign(1);
  args.element(2).assign(1);
}

/** Builds an indirect kernel with exact tail guarding, including an empty GPU range. */
export function computeRange(
  range: GPUComputeRange,
  callback: (index: Node<'uint'>) => void,
  workgroupSize = 64,
): ComputeNode {
  const node = Fn(() => {
    If(instanceIndex.lessThan(range.count), () => callback(instanceIndex));
  })().computeKernel([workgroupSize]);

  // Three supports indirect attributes at runtime; its declarations still expect numeric arrays.
  node.dispatchSize = range.dispatch as unknown as number[];

  return node;
}
