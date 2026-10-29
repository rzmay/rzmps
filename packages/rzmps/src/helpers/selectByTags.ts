import seedrandom from 'seedrandom';
import type { TaggedChoice, TaggedSelection } from './prepareTaggedSelection';

/** Returns a flattened leaf index, or -1 for no match. Arrays choose among resolvable branches. */
export default function selectByTags<T>(
  selection: TaggedSelection<T>,
  tags: readonly string[] = [],
  seed?: string,
  index?: number,
  offset = 0,
): number {
  const matches = (node: TaggedChoice): boolean => {
    if (node.kind === 'leaf') return true;
    if (node.kind === 'array') return node.first !== undefined || node.children.some(matches);
    return node.entries.some(([tag, child]) => (tag === '*' || tags.includes(tag)) && matches(child));
  };

  const visit = (node: TaggedChoice): number => {
    if (node.kind === 'leaf') return node.index;
    if (node.kind === 'tags') {
      for (const [tag, child] of node.entries) {
        if ((tag === '*' || tags.includes(tag)) && matches(child)) return visit(child);
      }
      return -1;
    }

    // A plain resource list is a constant-time indexed choice, regardless of its length.
    if (node.first !== undefined && node.children.length === 1) return node.first;
    let count = node.first !== undefined ? node.children.length : 0;
    if (node.first === undefined) for (const child of node.children) if (matches(child)) count++;
    if (!count) return -1;

    const random = index === undefined ? seed === undefined ? Math.random()
      : seedrandom.tychei(node.id ? `${seed}:${node.id}` : seed).quick() : 0;
    const selection = Math.floor(index ?? random * count) + Math.floor(offset);
    let remaining = ((selection % count) + count) % count;
    if (node.first !== undefined) return node.first + remaining;

    for (const child of node.children) {
      if (!matches(child)) continue;
      if (remaining-- === 0) return visit(child);
    }
    return -1;
  };
  return visit(selection.root);
}
