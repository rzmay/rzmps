/** A resource, random alternatives, or tag-keyed branches. Nested keys require every tag along the path. */
export type TaggedValue<T> = T | readonly TaggedValue<T>[] | { readonly [tag: string]: TaggedValue<T> };
