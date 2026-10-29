import seedrandom from 'seedrandom';
import { float, hash, uint } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { TaggedValue } from '../types/TaggedValue';

type Choice = { id: number } & (
  | { kind: 'leaf'; index: number }
  | { kind: 'array'; children: Choice[]; first?: number }
  | { kind: 'tags'; entries: Array<[string, Choice]> }
);

/** Compiles a static resource tree once; CPU and GPU selectors return a leaf index, or -1 for no match. */
export default class TaggedSelector<T> {
  readonly values: T[] = [];
  readonly tags: string[] = [];
  readonly structured: boolean;
  readonly single: boolean;
  private readonly root: Choice;

  constructor(value: TaggedValue<T>, isLeaf: (value: unknown) => value is T) {
    const active = new Set<object>();
    const tags = new Set<string>();
    let nextID = 0;
    const compile = (input: TaggedValue<T>): Choice => {
      const id = nextID++;
      if (isLeaf(input)) {
        const index = this.values.length;
        this.values.push(input);
        return { kind: 'leaf', id, index };
      }
      if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype
        && Object.getPrototypeOf(input) !== null && !Array.isArray(input)) {
        throw new TypeError('Expected a resource, an array of choices, or a plain tag map.');
      }
      if (active.has(input)) throw new TypeError('Tagged choices cannot contain cycles.');
      active.add(input);

      let result: Choice;
      if (Array.isArray(input)) {
        if (!input.length) throw new RangeError('Tagged choice arrays must contain at least one resource.');
        const children = input.map(compile);
        const first = children.every(child => child.kind === 'leaf')
          ? (children[0] as Extract<Choice, { kind: 'leaf' }>).index : undefined;
        result = { kind: 'array', id, children, first };
      } else {
        const entries = Object.entries(input) as Array<[string, TaggedValue<T>]>;
        if (!entries.length) throw new RangeError('Tag maps must contain at least one branch.');
        // A wildcard is a fallback even when it appears before named keys in the object.
        entries.sort(([a], [b]) => Number(a === '*') - Number(b === '*'));
        result = { kind: 'tags', id, entries: entries.map(([tag, child]) => {
          if (tag !== '*') tags.add(tag);
          return [tag, compile(child)];
        }) };
      }
      active.delete(input);
      return result;
    };

    this.root = compile(value);
    this.tags.push(...tags);
    this.single = isLeaf(value);
    this.structured = !this.single && !(Array.isArray(value) && value.every(isLeaf));
  }

  /** Arrays choose uniformly among resolvable children. An explicit index wraps within each chosen branch. */
  select(tags: readonly string[] = [], seed?: string, index?: number, offset = 0): number {
    const matches = (node: Choice): boolean => {
      if (node.kind === 'leaf') return true;
      if (node.kind === 'array') return node.first !== undefined || node.children.some(matches);
      return node.entries.some(([tag, child]) => (tag === '*' || tags.includes(tag)) && matches(child));
    };
    const visit = (node: Choice): number => {
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
    return visit(this.root);
  }

  /** Builds shader expressions using the particle's existing tag mask; adds no storage bindings. */
  selectGPU(
    tagMask: Node<'uint'>,
    maskForTag: (tag: string) => number,
    seed: Node<'uint'>,
    index?: Node<'float'>,
    offset: Node<'float'> = float(0),
  ): Node<'float'> {
    const visit = (node: Choice): Node<'float'> => {
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
    return visit(this.root);
  }
}
