# Spatial Effects and Module Collections

A generic `SpatialEffect` is an Object3D containing a volume or custom test and a modifier. Add it to the same Three.js scene as the particle system. The system discovers scene effects when `useSpatialEffects` is enabled, then combines them with its modules in priority order. The effect's transform places its volume in the scene; RZMPS converts particle positions for tests.

The `spatialEffects` constructor collection supplies explicit effects in addition to scene discovery. `spatialEffectFilter` narrows the generic effects that can modify a system. Avoid using a broad filter that accidentally excludes your intended field. Use `tags` and `condition` on an effect to select particles after the effect has been selected.

Modules can collect scene effects for their own algorithms. Set `requireSpatialEffects` to one or more SpatialEffect constructors; `prepare()` traverses the scene and fills the module's `spatialEffects` list with matching instances. This is how specialized modules such as Boids can consume affectors without the affectors also acting as generic modifiers.

For a module, explicitly supplying `spatialEffects: []` deliberately gives it an empty collection and suppresses discovery. Supplying a nonempty collection limits it to those objects. `spatialEffectFilter` and constructor requirements still filter that explicit list. Distinguish this module-level selection from the system's generic effects list.

Use [First Spatial Effect](first-spatial-effect.md) to build a field. For expensive selection, cache work in `prepare()`
rather than traversing the scene inside every particle callback. If you override `prepare()`, call
`super.prepare(context)` when you rely on the base spatial collection behavior.

On GPU, built-in analytic effects can be parameterized, batched, and indexed together. A custom
effect must provide GPU callbacks to run there; an unsupported generic effect is skipped rather
than forcing the whole system to CPU. Geometry-backed custom effects can use a baked inclusion
field, and `updatePolicy` distinguishes static, transform-only, and deforming geometry updates.
Optional system bounds filtering applies only to effects whose built-in geometry test guarantees
that bounds overlap is meaningful. See [GPU processing](gpu-processing.md) for callback signatures
and update policies.
