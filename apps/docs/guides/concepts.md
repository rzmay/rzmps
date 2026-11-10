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

Continuous emission retains fractional spawn timing between updates. Each newborn simulates only the time after its birth within the current step; scheduled bursts retain their own times. Module `deltaTime` arguments are seconds available to the selected particle. `realtime` remains age in milliseconds, and `time` remains normalized age. Initialization hooks and spawn observers see age zero.

`substep` defaults to `true`. Display updates and `advanceFrames()` divide large simulation deltas using `substepDeltaTime`, which defaults to `1 / prewarmFPS` (24 FPS by default). Each substep includes emission, modules, spatial queries, collisions, lifecycle events, and owned subsystems. Renderer handoff and live environment capture occur after the final step. Set `substep: false` to integrate an interval once while retaining accurate birth ages.

`maxCatchup` defaults to `null`, which uses the larger of system duration and finite maximum initial emitter lifetimes. `Emitter.getMaxLifetime()` uses the shared `maxDynamicNumber` sampler for constants, ranges, sets, and functions. Functions sample normalized time using `ParticleSystem.Settings.GPU_DYNAMIC_VALUE_RESOLUTION`; these maxima are approximate and may miss peaks between samples. Opaque values with no readable finite samples return `null` and are ignored. The estimate follows runtime edits to duration and emitter definitions. Set `maxCatchup` to an explicit number of simulation-time seconds to override it. A separate internal safeguard limits work to 240 substeps per supplied interval.

When elapsed time exceeds either limit, emitter and source clocks advance across the discarded older interval without births, historical burst replay, or accumulated distance credit. Only the recent interval is simulated; continuous rates keep their fractional phase. This is approximate and does not reconstruct missed spatial interactions, modified lifetimes, or unobserved event chains. Pauses take precedence: paused updates advance the wall-clock baseline without simulating, and `start()` resets that baseline even when no updates occurred during the pause. `start()` continues to restart the emission cycle.

The loop duration schedules emission; it is independent of each particle's lifetime. Turning looping off does not necessarily delete existing particles: `endBehavior` determines what happens after the duration. A population estimate for constant emission is rate multiplied by average lifetime, before bursts, culling, or subsystems. These are nominal estimates: timestep quantization and emission scheduling can lower the observed count. Set `maxParticles` to bound simulation costs, and remember that each renderer adds work.

[Subsystems](subsystems.md) attach secondary effects to lifecycle events. [Spatial effects and collections](spatial-effects.md) coordinate scene-wide behavior. Both rendering backends use this same composition model; see [compatibility](compatibility.md) and [GPU processing](gpu-processing.md).

The exported `sampleDynamicValue(value, sample, resolution = 16)` reduces dynamic leaves using a custom `(a, b) => result` callback. It visits range endpoints and set members and samples functions over normalized time. `maxDynamicNumber` / `minDynamicNumber`, `maxDynamicVector` / `minDynamicVector`, and `maxDynamicColor` / `minDynamicColor` provide common reductions. Vector and color extrema are component-wise and return independent objects. These are sampled estimates for functions, not guaranteed mathematical bounds. Numeric helpers return zero for unreadable inputs unless an explicit third fallback argument is supplied; vectors return zero and colors return black. The generic reducer returns `undefined` when no readable leaf exists and accepts a fourth callback for input normalization.
