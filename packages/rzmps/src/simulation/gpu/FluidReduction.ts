import { IndirectStorageBufferAttribute, StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import {
  Fn, If, float, instanceIndex, localId, max, storage, uint, vec4,
  workgroupArray, workgroupBarrier, workgroupId,
} from 'three/tsl';
import type { ParticleSpatialGridRenderer } from '../../spatial/structures/ParticleSpatialGrid';
import { writeComputeDispatch, type GPUComputeRange } from '../../utils/gpu/computeDispatch.utils';
import { bindStorageAttributeLifetime } from '../../utils/gpu/storage.utils';

type Vectors = { element(index: Node | number): Node<'vec4'> };

/** Optional compact field range. Address mapping preserves the owner's dense or sparse storage. @internal */
export interface FluidReductionRange {
  count: Node<'uint'>;
  index: (compactIndex: Node<'uint'>) => Node<'uint'>;
}

/** Cooperative, hierarchical reduction; no invocation serially walks the complete field. @internal */
export default class FluidReduction {
  readonly attribute = new StorageBufferAttribute(new Float32Array(12), 4);
  readonly result = storage(this.attribute, 'vec4', 3);
  private readonly partialAttribute: StorageBufferAttribute;
  private readonly partial: Vectors;
  private readonly chunks: number;
  private readonly reduceNodes: ComputeNode[] = [];
  private readonly attributes: StorageBufferAttribute[] = [];
  private readonly nodes = new WeakMap<object, ComputeNode>();
  private readonly createdNodes = new Set<ComputeNode>();
  private readonly range?: GPUComputeRange;
  private readonly scheduleNode?: ComputeNode;
  private storageRenderer?: ParticleSpatialGridRenderer;

  /** count reserves the complete hierarchy; compact.count is the live runtime population. */
  constructor(private readonly count: number, private readonly compact?: FluidReductionRange) {
    this.chunks = Math.max(1, Math.ceil(count / 256));
    this.partialAttribute = new StorageBufferAttribute(new Float32Array(this.chunks * 12), 4);
    this.partial = storage(this.partialAttribute, 'vec4', this.chunks * 3) as Vectors;
    this.attributes.push(this.partialAttribute);
    if (compact) {
      const dispatch = new IndirectStorageBufferAttribute(new Uint32Array(3), 1);
      this.range = { count: compact.count, dispatch };
      this.attributes.push(dispatch);
      this.scheduleNode = Fn(() => { writeComputeDispatch(this.range!, 256); })().compute(1);
    }

    let input = this.partial;
    let size = this.chunks;
    let active = compact ? compact.count.add(255).div(256) : uint(size);
    do {
      const groups = Math.ceil(size / 64);
      const final = groups === 1;
      let output: Vectors = this.result;
      if (!final) {
        const attribute = new StorageBufferAttribute(new Float32Array(groups * 12), 4);
        this.attributes.push(attribute);
        output = storage(attribute, 'vec4', groups * 3) as Vectors;
      }
      // Capture each level's bindings before building the next level.
      this.reduceNodes.push(this.buildLevel(input, output, active, groups, final));
      input = output;
      size = groups;
      // Later levels must not read stale partials after the compact population shrinks.
      active = active.add(63).div(64);
    } while (size > 1);
  }

  private combine(maxima: Node<'vec4'>, sums: Node<'vec4'>, counts: Node<'vec4'>,
    output: Vectors, final: boolean): void {
    const sharedMax = workgroupArray('vec4', 64) as unknown as Vectors;
    const sharedSum = workgroupArray('vec4', 64) as unknown as Vectors;
    const sharedCount = workgroupArray('vec4', 64) as unknown as Vectors;
    sharedMax.element(localId.x).assign(maxima);
    sharedSum.element(localId.x).assign(sums);
    sharedCount.element(localId.x).assign(counts);
    workgroupBarrier();
    for (let stride = 32; stride >= 1; stride /= 2) {
      If(localId.x.lessThan(stride), () => {
        sharedMax.element(localId.x).assign(max(
          sharedMax.element(localId.x), sharedMax.element(localId.x.add(stride)),
        ));
        sharedSum.element(localId.x).addAssign(sharedSum.element(localId.x.add(stride)));
        sharedCount.element(localId.x).addAssign(sharedCount.element(localId.x.add(stride)));
      });
      workgroupBarrier();
    }
    If(localId.x.equal(0), () => {
      const group = workgroupId.x.mul(3);
      output.element(group).assign(sharedMax.element(uint(0)));
      output.element(group.add(1)).assign(final
        ? sharedSum.element(uint(0)).div(sharedCount.element(uint(0)).x.max(1)) : sharedSum.element(uint(0)));
      output.element(group.add(2)).assign(sharedCount.element(uint(0)));
    });
  }

  private buildLevel(input: Vectors, output: Vectors, active: Node<'uint'>,
    groups: number, final: boolean): ComputeNode {
    return Fn(() => {
      const maxima = vec4(0).toVar();
      const sums = vec4(0).toVar();
      const counts = vec4(0).toVar();
      If(instanceIndex.lessThan(active), () => {
        const offset = instanceIndex.mul(3);
        maxima.assign(input.element(offset));
        sums.assign(input.element(offset.add(1)));
        counts.assign(input.element(offset.add(2)));
      });
      this.combine(maxima, sums, counts, output, final);
    })().compute(groups * 64, [64]);
  }

  compute(renderer: ParticleSpatialGridRenderer, key: object,
    sample: (index: Node<'uint'>) => Node<'vec4'>,
    active: (index: Node<'uint'>) => Node<'bool'>, absolute = true): void {
    this.storageRenderer = renderer;
    let node = this.nodes.get(key);
    if (!node) {
      node = Fn(() => {
        const maxima = vec4(0).toVar();
        const sums = vec4(0).toVar();
        const count = float(0).toVar();
        const invalid = float(0).toVar();
        // Four adjacent runs keep loads coalesced and every lane reaches every barrier.
        for (let item = 0; item < 4; item++) {
          const compactIndex = workgroupId.x.mul(256).add(localId.x).add(item * 64);
          If(compactIndex.lessThan(this.compact?.count ?? uint(this.count)), () => {
            const index = this.compact ? this.compact.index(compactIndex) : compactIndex;
            If(active(index), () => {
              const value = absolute ? sample(index).abs() : sample(index);
              If(value.abs().lessThanEqual(vec4(3e38)).all(), () => {
                maxima.assign(max(maxima, value.abs()));
                sums.addAssign(value);
              }).Else(() => {
                maxima.assign(vec4(3e38));
                invalid.addAssign(1);
              });
              count.addAssign(1);
            });
          });
        }
        this.combine(maxima, sums, vec4(count, invalid, 0, 0), this.partial, false);
      })().compute(this.chunks * 64, [64]);
      if (this.range) node.dispatchSize = this.range.dispatch as unknown as number[];
      this.nodes.set(key, node);
      this.createdNodes.add(node);
    }
    if (this.scheduleNode) renderer.compute(this.scheduleNode);
    renderer.compute(node);
    renderer.compute(this.reduceNodes);
  }

  get allocatedBytes(): number {
    return this.attribute.array.byteLength
      + this.attributes.reduce((sum, attribute) => sum + attribute.array.byteLength, 0);
  }

  dispose(): void {
    if (this.storageRenderer) {
      for (const attribute of [this.attribute, ...this.attributes])
        bindStorageAttributeLifetime(this.storageRenderer, attribute);
    }
    this.attribute.dispose();
    this.attributes.forEach(attribute => attribute.dispose());
    [...this.createdNodes, ...this.reduceNodes, this.scheduleNode].forEach(node => node?.dispose());
  }
}
