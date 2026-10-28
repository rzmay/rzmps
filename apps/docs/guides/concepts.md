# Composition and Lifecycle

A `ParticleSystem` owns arrays of emitters, modules, renderers, and explicitly selected spatial effects. These are mutable collections; use `addEmitter`, `addModule`, `addRenderer`, and their removal methods when changing composition so setup and cleanup hooks run. Passing a single component to the constructor is also supported. Constructor options may be copied to instance fields, so changing an options object later does not always reconfigure a component. Check the exposed runtime property and its source before relying on live edits.

An emitter chooses where particles are born, their initial values, tags, and birth times. `rate` is particles per second; `rateOverDistance` adds emission based on source movement. A burst fires when its time is crossed. Lifetimes are seconds, while lifetime module callbacks receive normalized age from zero to one. A two-element array usually defines a sampled range; a `Set` selects a discrete value. Consult the exported dynamic-value types when supplying callbacks.

Each update restores cached permanent values, prepares modules once, sorts modifiers into priority phases, integrates particles, then sends the resulting particle list to renderers. [Module priority](module-priority.md) explains which changes persist. Renderers can share one simulated population: a sprite, trail, light, and sound can all represent the same particle. [Tags](tags.md) select subsets without duplicating simulation.

## Finding Modules

`system.getModules(SomeModuleClass)` returns matching modules, including subclasses
and dependent modules. Results preserve attachment order, with dependents before
their owners, and contain each instance once. Queries reflect the current module
collection and do not search subsystem particle systems.

Pass an optional tag array, such as `system.getModules(SomeModuleClass, ['smoke'])`,
to select modules with any overlapping tag. A null or undefined filter matches
all modules, and modules with null or undefined tags match every filter. An
empty array is an explicit empty selection, so only untagged modules match it.

TypeScript interfaces are erased at runtime. To query a capability, supply its
interface type and an array of identifying member names. Every requested member
must exist, including inherited members; optional members need not be requested.
This is a structural presence check, not validation of member types or signatures.
Use constructors when nominal identity matters, or query modules that honor the
declared contract. An empty member array selects every module.

```ts
const providers = system.getModules<VolumeFieldProvider>(['getVolumeField']);
const field = providers[0]?.getVolumeField();
```

A volume provider implements `getVolumeField()` and optionally
`getVolumeColorField()`. Either method may return `undefined` while its field is
unavailable. Without explicit fields, `VolumeRenderer` finds all providers
overlapping its own tags. It samples each density field in its own bounds and
resolution, adds densities, and blends each provider's color by its density
contribution. A missing color uses the renderer's base color. The rendered box
encloses the union of contributing density bounds; fields contribute nothing
outside their own bounds.

An explicit density field replaces discovered density fields. An explicit color
field overrides provider colors. Field callbacks retain control over temporary
unavailability. Multiple fields are sampled in one ray march, not blended as
separately ordered transparent boxes. Each provider adds texture sampling cost;
composition does not merge or modify the simulations themselves.

Volume rendering separates reconstruction (`interpolation`: `Nearest`, `Linear`,
or `Cubic`) from integration quality (`stepSizeMultiplier`, relative to cell size,
bounded by `steps`). Opacity is distance-corrected so quality changes do not
silently act as density gain. `densityGain` is an explicit appearance multiplier.
`densityMapping` selects `Smoothstep` (existing `threshold`/`range`), `Linear`,
`Curve`, or `None`. Linear/Curve use `densityRange`; `densityCurve` follows
`ValueByParameter<number>` and is sampled to a lookup texture. These controls
do not change source emission, dissipation, diffusion, or liquid dynamics.

`start()` starts playback and resets the emission cycle, including when restarting a paused system. `pause()` freezes simulation. `stop(clearParticles)` stops emission and resets system time; surviving particles can continue moving on subsequent updates when they are retained. `destroy()` permanently releases owned resources. Removing a system from its scene performs temporary cleanup so it can be attached elsewhere. Call `destroy()` when you will no longer use it.

The loop duration schedules emission; it is independent of each particle's lifetime. Turning looping off does not necessarily delete existing particles: `endBehavior` determines what happens after the duration. A population estimate for constant emission is rate multiplied by average lifetime, before bursts, culling, or subsystems. These are nominal estimates: timestep quantization and emission scheduling can lower the observed count. Set `maxParticles` to bound simulation costs, and remember that each renderer adds work.

[Subsystems](subsystems.md) attach secondary effects to lifecycle events. [Spatial effects and collections](spatial-effects.md) coordinate scene-wide behavior. Both rendering backends use this same composition model; see [compatibility](compatibility.md) and [GPU processing](gpu-processing.md).
