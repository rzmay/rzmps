export type ValueByParameter<T> =
    T
    | ((t: number) => ValueByParameter<T>)
    | [ValueByParameter<T>, ValueByParameter<T>];
