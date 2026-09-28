import type { Node } from 'three/webgpu';

export type ValueByParameter<T> =
    T
    | Node
    | ((t: number) => ValueByParameter<T>)
    | [ValueByParameter<T>, ValueByParameter<T>];
