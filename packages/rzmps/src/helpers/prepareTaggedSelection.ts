import type { TaggedValue } from '../types/TaggedValue';

export type TaggedChoice = { id: number } & (
  | { kind: 'leaf'; index: number }
  | { kind: 'array'; children: TaggedChoice[]; first?: number }
  | { kind: 'tags'; entries: Array<[string, TaggedChoice]> }
);

/** Static resource metadata shared by CPU and GPU tag selection. */
export interface TaggedSelection<T> {
  readonly values: readonly T[];
  readonly tags: readonly string[];
  readonly structured: boolean;
  readonly single: boolean;
  /** @internal Compiled branch graph; prepare once before selecting particles. */
  readonly root: TaggedChoice;
}

/** Flattens and validates a static resource tree once, preserving branch-local random choices. */
export default function prepareTaggedSelection<T>(
  value: TaggedValue<T>,
  isLeaf: (value: unknown) => value is T,
): TaggedSelection<T> {
  const values: T[] = [];
  const active = new Set<object>();
  const tags = new Set<string>();
  let nextID = 0;
  const compile = (input: TaggedValue<T>): TaggedChoice => {
    const id = nextID++;
    if (isLeaf(input)) {
      const index = values.length;
      values.push(input);
      return { kind: 'leaf', id, index };
    }
    if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype
      && Object.getPrototypeOf(input) !== null && !Array.isArray(input)) {
      throw new TypeError('Expected a resource, an array of choices, or a plain tag map.');
    }
    if (active.has(input)) throw new TypeError('Tagged choices cannot contain cycles.');
    active.add(input);

    let result: TaggedChoice;
    if (Array.isArray(input)) {
      if (!input.length) throw new RangeError('Tagged choice arrays must contain at least one resource.');
      const children = input.map(compile);
      const first = children.every(child => child.kind === 'leaf')
        ? (children[0] as Extract<TaggedChoice, { kind: 'leaf' }>).index : undefined;
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

  const root = compile(value);
  const single = isLeaf(value);
  const structured = !single && !(Array.isArray(value) && value.every(isLeaf));
  return { values, tags: [...tags], single, structured, root };
}
