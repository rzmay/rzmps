import { StorageBufferAttribute, IndirectStorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import { Fn, If, storage, uint, instanceIndex, localId, workgroupId, workgroupArray,
  workgroupBarrier } from 'three/tsl';
import { destroyGPUStorageAttribute } from './Particle';
import type { GPUStorageBufferRenderer, ScalarUintStorage } from './Storage';
import { computeRange, writeComputeDispatch, type GPUComputeRange } from './ComputeDispatch';

/** Reusable hierarchical exclusive uint scan. All synchronization is within a workgroup or between dispatches. */
export default class GPUExclusiveScan {
  readonly nodes: ComputeNode[] = [];
  private readonly attributes: StorageBufferAttribute[] = [];
  private readonly commands: GPUComputeRange[] = [];

  constructor(
    count: number,
    read: (index: Node<'uint'>) => Node<'uint'>,
    write: (index: Node<'uint'>, value: Node<'uint'>) => void,
    activeCount: Node<'uint'> = uint(count),
  ) {
    this.build(Math.max(1, count), read, write, activeCount);
    this.nodes.unshift(Fn(() => {
      this.commands.forEach(command => writeComputeDispatch(command));
    })().compute(1).setName('rzmps.spatial.scanSchedule'));
  }

  private build(
    count: number,
    read: (index: Node<'uint'>) => Node<'uint'>,
    write: (index: Node<'uint'>, value: Node<'uint'>) => void,
    activeCount: Node<'uint'>,
  ): void {
    // Retain block totals and local prefixes for the later offset pass.
    const groups = Math.ceil(count / 64);
    const attribute = new StorageBufferAttribute(new Uint32Array(groups * 2), 1);
    this.attributes.push(attribute);
    const data = storage(attribute, 'uint', groups * 2) as ScalarUintStorage;

    const prefixAttribute = new StorageBufferAttribute(new Uint32Array(count), 1);
    this.attributes.push(prefixAttribute);
    const prefix = storage(prefixAttribute, 'uint', count) as ScalarUintStorage;
    const store = (index: Node<'uint'>, value: Node<'uint'>) => {
      prefix.element(index).assign(value);
      write(index, value);
    };

    const shared = workgroupArray('uint', 64) as unknown as ScalarUintStorage;
    const dispatch = new IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1]), 1);
    this.attributes.push(dispatch);
    const range = { count: activeCount, dispatch };
    this.commands.push(range);

    // Scan each workgroup independently, keeping inactive lanes neutral at every barrier.
    this.nodes.push(Fn(() => {
      const original = uint(0).toVar();
      If(instanceIndex.lessThan(activeCount), () => {
        original.assign(read(instanceIndex));
      });
      shared.element(localId.x).assign(original);
      workgroupBarrier();

      for (let offset = 1; offset < 64; offset *= 2) {
        const preceding = uint(0).toVar();
        If(localId.x.greaterThanEqual(offset), () => {
          preceding.assign(shared.element(localId.x.sub(offset)));
        });
        workgroupBarrier();
        shared.element(localId.x).addAssign(preceding);
        workgroupBarrier();
      }

      If(instanceIndex.lessThan(activeCount), () => store(instanceIndex, shared.element(localId.x).sub(original)));
      If(localId.x.equal(63), () => {
        data.element(workgroupId.x).assign(shared.element(uint(63)));
      });
    })().computeKernel([64]).setName('rzmps.spatial.scan'));
    this.nodes[this.nodes.length - 1].dispatchSize = dispatch as unknown as number[];

    // Recursively scan block totals, then add those offsets to each local prefix.
    if (groups > 1) {
      this.build(groups, i => data.element(i), (i, value) => data.element(i.add(groups)).assign(value),
        activeCount.add(63).div(64));
      this.nodes.push(computeRange(range, index => {
        store(index, prefix.element(index).add(data.element(index.div(64).add(groups))));
      }).setName('rzmps.spatial.scanOffsets'));
    }
  }

  dispose(renderer?: GPUStorageBufferRenderer): void {
    this.nodes.forEach(node => node.dispose());
    this.attributes.forEach(attribute => destroyGPUStorageAttribute(renderer, attribute));
  }
}
