# Spatial Effects and Module Collections

A generic `SpatialEffect` is an Object3D containing a volume or custom test and a modifier. Add it to the same Three.js scene as the particle system. The system discovers scene effects when `useSpatialEffects` is enabled, then combines them with its modules in priority order. The effect's transform places its volume in the scene; RZMPS converts particle positions for tests.

The `spatialEffects` constructor collection supplies explicit effects in addition to scene discovery. `spatialEffectFilter` narrows the generic effects that can modify a system. Avoid using a broad filter that accidentally excludes your intended field. Use `tags` and `condition` on an effect to select particles after the effect has been selected.

Modules collect effects through `requireSpatialEffects`. Constructors discover scene instances,
including subclasses; exact effect instances are included directly without requiring scene membership.
The resulting collection deduplicates by object identity. This lets specialized modules such as Boids
consume affectors without the affectors also acting as generic modifiers.

Explicit module `spatialEffects` lists suppress scene discovery, including when empty. Requirements
still filter that list, while directly required instances are included independently. The module's
`spatialEffectFilter` applies to every selected effect. This differs from the system's generic effects list.

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

## Typed module collections

The module's collection remains an array: iteration, indexing, `filter()` and `length` work as usual.
`context.spatialEffects.get(BoidAffector)` returns typed constructor matches, including subclasses.
An effect matching multiple required constructors occurs once in the flat list and in each matching
bucket. Constructor identity, rather than a constructor name or string key, selects the bucket.
The flat list is canonical; constructor lookup refreshes its bucket after array mutations.
CPU callbacks, GPU callbacks and module compute/render hooks share the owning module's collection.

```ts
const module = new Module(() => {}, {
  requireSpatialEffects: [SpatialEffect, BoidAffector],
  prepare(context) {
    for (const affector of context.spatialEffects.get(BoidAffector)) {
      // The same object is also present in the flat collection.
      affector.updateWorldMatrix(true, false);
    }
  },
});
```

## Sampling ordinary effects

`effect.sampleDeltas(position, partialState, dt, system)` reuses a scratch particle and delta objects.
Copy a CPU result if it must survive the next sample on that effect. `sampleDeltasGPU(position, state,
dt, context)` creates shader-local state without GPU buffers or readbacks. Both paths honor normal
conditions, geometry, transforms, inversion, tags and feathering. GPU effects still require GPU callbacks.

The returned supported particle deltas include velocity, color, alpha, mass, position, rotation and
scale, plus a discrete `killed` result. Automatic feathering uses the same before/after implementation
as ordinary particle updates. Killing is discrete rather than fractionally reviving a particle.

## Gas effects

GasSimulation retains FluidCollider boundary discovery. Modifier sampling is opt-in through
`supportSpatialEffects`, `supportForceFields` or explicit `requireSpatialEffects`; ordinary source-particle
effects are not automatically applied to the gas again. Constructor requirements merge at construction;
subsequent direct assignment is authoritative. Replacing the list does not silently reinsert defaults.

Both convenience flags default to false. `supportSpatialEffects: true` adds the SpatialEffect constructor
to the existing requirements, collecting all compatible modifiers, including force fields and GasAffector.
With broad support disabled, `supportForceFields: true` adds only ParticleForceField. Both disabled means
no automatic modifier sampling; collider boundaries are independent. Explicit custom requirements remain
authoritative. Setting either flag only adds/removes its constructor, preserving other requirements.
The effective `supportForceFields` getter remains true while broad discovery is enabled, even if its
narrower flag is set false. Gas demos enable broad discovery. Discovery, filtering and delta sampling
use the same path as explicit requirements; there is no second effect system or new field storage.

Required ordinary effects sample active, non-solid cells. Their pseudoparticle has the cell center,
velocity, specific color, density as alpha, density times cell volume as mass, and cell size as scale.
ParticleForceField compatibility retains unit reference carrier-air mass so force acceleration does
not diverge as smoke fades or change with resolution. Particle-compatible
velocity, color and alpha changes map back to gas; kill clears density, heat and transported color.
Changes to position, rotation, scale and mass do not move or resize the Eulerian cells.

Permanent velocity changes occur before projection. Permanent scalar changes follow transport and
source injection. Transient effects run in priority order on the provider's renderable fields and do
not mutate persistent state. Transient velocity can drive render-time speed appearance; it does not
advect gas. Vorticity remains the physical solver's curl. No duplicate volume is created per effect.

GasAffector takes an unrestricted GPU gas callback as its first argument:

```ts
const heater = new GasAffector((gas, dt, context, strength) => {
  gas.temperature.addAssign(float(2).mul(dt).mul(strength));
  gas.velocity.y.addAssign(dt.mul(strength));
}, { geometry: new THREE.SphereGeometry(2), feather: 1 });

const simulation = new GasSimulation({
  supportForceFields: true,
  requireSpatialEffects: [heater],
});
```

The callback can modify density, specific temperature, velocity and specific color. Cell position is
the sample location; structural solver settings are not local gas state. The solver converts semantic
temperature/color back to heat/color mass and clears them when density reaches zero. GasAffector has
no CPU particle modifier or `modifyGPU` constructor option, and does not modify source particles.
Optional density/temperature/velocity/drag/color convenience controls compose before the callback.
The callback receives feather strength explicitly and applies it as appropriate for its behavior.
Permanent velocity and scalar phases evaluate the callback separately, retaining only the relevant
fields in each phase; transient callbacks operate on the existing visual scratch state.

Shape factories also accept `(gasCallback, options, ...geometryArgs)`, along with their convenience
options-only forms. Transforms, conditions, tags, inversion, feather and update policies remain inherited.
Convenience curves vary from full influence (parameter zero) to the feather's outer edge (parameter one);
literal convenience values remain constant. Effects are sampled on existing active solver cells;
emitters provide the initial active gas support. A density source over an empty active cell starts
with neutral white color unless the affector supplies a tint.

The gas module's tags select its source group; matching effects modify that group's mixed field.
A mixed cell does not retain separate per-particle tag identities. Configure separate tagged gas
modules when fields need independent spatial-effect selection.

Select the **Gas Spatial Effects** scene with a gas preset to compare three regions:
a static, feathered permanent wind sphere; a static, hard-edged permanent heating box;
and a moving, feathered Suzanne mesh that transiently tints and attenuates the rendered gas.
The scene owns the effects, helpers and animation, independently of the selected particle preset.
Ordinary particle presets also respond to its wind field; the gas-specific regions require GasSimulation.
