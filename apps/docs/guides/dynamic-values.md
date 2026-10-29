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

Lifetime-module callbacks receive normalized particle age, from `0` to `1`. Emitter rate and birth-value callbacks
instead receive normalized emission-cycle time. A callback is evaluated in its component’s context; it does not receive
wall-clock seconds.

| Form           | Example                       | Behavior                               |
| -------------- | ----------------------------- | -------------------------------------- |
| Static value   | `2`                           | Always returns the same value.         |
| Function       | `(t) => 1 - t`                | Re-evaluates over normalized lifetime. |
| Two-item array | `[0.5, 2]`                    | Random value between min and max.      |
| Set            | `new Set(["spark", "smoke"])` | Random choice.                         |

Dynamic values are supported for numbers, vectors, and colors where the option
type uses `DynamicValue<number>`, `DynamicValue<THREE.Vector3>`, or
`DynamicValue<THREE.Color>`.

Color inputs accept `THREE.Color`, hex numbers, and CSS color strings (the same values
as `new THREE.Color(...)`). Uniform-axis inputs such as scale, scale velocity/acceleration,
noise strength, rotation/angular velocity/angular acceleration, and velocity limits also accept a number: `scale: 2`
means
`new THREE.Vector3(2, 2, 2)`. Positions and directional inputs still require vectors.
These shortcuts work inside callbacks, ranges, and sets too, including GPU processing;
particle state always contains `THREE.Color` and `THREE.Vector3` objects.

```ts
initialValues: {
  color: new Set(["#ff8844", 0xffcc00]),
  scale: [0.1, 0.5],
}
// Lifetime modifier: scale: (t) => 1 + t
```

## Rotation Shortcuts

Birth `rotation`, `angularVelocity`, and `angularAcceleration`, plus the corresponding rotation-module options,
accept `Vector3Input`: a scalar or a `THREE.Vector3`. As with scale, a scalar expands uniformly across X, Y and Z.
Billboard sprites use X for their screen-space roll, so a scalar is sufficient. Meshes and non-billboard sprites
still use all three axes; supply an explicit vector for axis-specific rotation.

```ts
new Emitter({ initialValues: {
  rotation: [0, Math.PI * 2],
  angularVelocity: 0.65,
} });
new RotationOverLifetime({ angularVelocity: new Set([-1.8, 1.8]) });
new RotationBySpeed({ speedRange: [0, 10], angularVelocity: [0, 2] });
```

Angles use radians, angular velocity uses radians per second, and angular acceleration uses radians per second
squared. Lifetime options support constants, ranges, sets and callbacks, on CPU and GPU. Size, speed and depth options
retain their `ValueByParameter` semantics: ranges interpolate, direct values scale with the normalized parameter,
and callbacks supply explicit results. The particle's stored angular channels remain `THREE.Vector3` objects.

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

GPU built-ins support the same constant, range, set, and callback forms. Function values are
sampled into an interpolated lookup table with `ParticleSystem.GPU_DYNAMIC_VALUE_RESOLUTION`
entries, so sharp or high-frequency curves may need a higher resolution. GPU-aware options can
also accept TSL nodes. Runtime value changes synchronize automatically; a change that alters a
custom shader graph's structure should additionally set that component's `needsUpdate` flag.
