import type { Node } from 'three/webgpu';

export type DynamicValue<T> =
    T
    | Node
    | ((t: number) => DynamicValue<T>)
    | [DynamicValue<T>, DynamicValue<T>]
    | Set<DynamicValue<T>>;

export type DynamicUntimedValue<T> = Exclude<DynamicValue<T>, ((t: number) => DynamicValue<T>)>
