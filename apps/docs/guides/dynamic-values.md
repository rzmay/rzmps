# Dynamic Values

Many RZMPS options use `DynamicValue<T>`.

```ts
type DynamicValue<T> =
  | T
  | ((t: number) => DynamicValue<T>)
  | [DynamicValue<T>, DynamicValue<T>]
  | Set<DynamicValue<T>>;

// Used for parameters that can take multiple elements or just one
type Multiple<T> = T | T[];

// Multiple with least one value
type StrictMultiple<T> = T | [T, ...[T]];

// In RZMPS, tags are natively strings
type Tag = string;
```

Lifetime-module callbacks receive normalized particle age, from `0` to `1`. Emitter rate and birth-value callbacks instead receive normalized emission-cycle time. A callback is evaluated in its component’s context; it does not receive wall-clock seconds.

| Form           | Example                       | Behavior                               |
| -------------- | ----------------------------- | -------------------------------------- |
| Static value   | `2`                           | Always returns the same value.         |
| Function       | `(t) => 1 - t`                | Re-evaluates over normalized lifetime. |
| Two-item array | `[0.5, 2]`                    | Random value between min and max.      |
| Set            | `new Set(["spark", "smoke"])` | Random choice.                         |

Dynamic values are supported for numbers, vectors, and colors where the option
type uses `DynamicValue<number>`, `DynamicValue<THREE.Vector3>`, or
`DynamicValue<THREE.Color>`.

The [curves](https://www.npmjs.com/package/curves) package was designed and
built to streamline functional values by defining and evaluating eased curves,
similar to Unity's AnimationCurves with modifiers akin to Blender's FCurve
Modifiers. It has prebuilt keyframe types for numbers, colors, and vectors,
compatible with the `THREE.Vector3` and `THREE.Color` types.


## Parameter-Based Values

Depth, size, and speed modules use `ValueByParameter<T>` rather than random dynamic ranges.
A two-element array interpolates between its endpoints using the normalized parameter.
A direct numeric or vector value scales with that parameter; a function returns its explicit
result. For example, `[0.5, 2]` interpolates from 0.5 to 2, while `() => 2` supplies a constant
result. Check the option's actual type before assuming an array means random sampling.

Random lifetime values are often evaluated with a particle ID seed, so a particle keeps
its sampled choice across repeated module updates. Emitter birth sampling selects new
values for new particles. Do not mutate a vector supplied as a shared option inside a
custom callback; update the particle's own state or reuse a separate scratch vector.
