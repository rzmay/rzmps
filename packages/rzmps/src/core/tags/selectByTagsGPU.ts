import { float, hash, uint } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { TaggedChoice, TaggedSelection } from './prepareTaggedSelection';

/** Builds the matching leaf-index expression from existing particle tag masks; adds no storage bindings. */
export default function selectByTagsGPU<T>(
  selection: TaggedSelection<T>,
  tagMask: Node<'uint'>,
  maskForTag: (tag: string) => number,
  seed: Node<'uint'>,
  index?: Node<'float'>,
  offset: Node<'float'> = float(0),
): Node<'float'> {
  const visit = (node: TaggedChoice): Node<'float'> => {
    if (node.kind === 'leaf') return float(node.index);
    let result: Node<'float'> = float(-1);
    if (node.kind === 'tags') {
      for (let i = node.entries.length - 1; i >= 0; i--) {
        const [tag, child] = node.entries[i];
        const value = visit(child);
        const matched = tag === '*' ? value.greaterThanEqual(0)
          : tagMask.bitAnd(uint(maskForTag(tag))).notEqual(0).and(value.greaterThanEqual(0));
        result = matched.select(value, result);
      }
      return result;
    }

    const randomSeed = node.id ? seed.bitXor(uint((node.id * 2246822519) % 4294967296)) : seed;
    if (node.first !== undefined) {
      if (node.children.length === 1) return float(node.first);
      const size = float(node.children.length);
      const selection = (index ?? hash(randomSeed).mul(size)).floor().add(offset.floor());
      return selection.mod(size).add(size).mod(size).add(node.first);
    }

    const children = node.children.map(visit);
    const count = children.reduce<Node<'float'>>((sum, value) =>
      sum.add(value.greaterThanEqual(0).select(1, 0)), float(0));
    const selection = (index ?? hash(randomSeed).mul(count)).floor().add(offset.floor());
    const size = count.max(1);
    const selected = selection.mod(size).add(size).mod(size);
    let ordinal: Node<'float'> = float(0);
    for (const value of children) {
      const valid = value.greaterThanEqual(0);
      result = valid.and(selected.equal(ordinal)).select(value, result);
      ordinal = ordinal.add(valid.select(1, 0));
    }
    return result;
  };
  return visit(selection.root);
}
