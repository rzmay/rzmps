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
contribution. A missing color uses the renderer’s `color`. The rendered box
encloses the union of contributing density bounds; fields contribute nothing
outside their own bounds.

An explicit density field replaces discovered density fields. An explicit color
field overrides provider colors. Field callbacks retain control over temporary
unavailability. Multiple fields are sampled in one ray march, not blended as
separately ordered transparent boxes. Each provider adds texture sampling cost;
composition does not merge or modify the simulations themselves.

`VolumeRenderer.softParticleDistance` matches SpriteRenderer's view-space intersection fade distance:
zero (the default) disables fading, and positive values smoothly reduce each sample's opacity near
opaque geometry. `softParticles: false` disables the fade while preserving hard scene-depth clipping.
Volume softness reuses the existing WebGPU scene-depth sample, including downsampled rendering;
it adds no scene pass and does not change simulation density, collisions or bounds. It requires
`depthTest`; the existing WebGL volume path does not supply scene depth and remains unchanged.

Sprite soft-particle depth preserves scene materials' front/back/double-sided culling, visible material
groups and alpha cutouts. Visible transparent scene surfaces still participate in that intersection
depth; particle-renderer proxies are excluded. WebGPU volume clipping instead samples the opaque
depth captured at the end of ordinary opaque drawing, before transmissive/transparent objects write
depth. Full and reduced-resolution volumes reuse that snapshot, without another scene geometry pass.
Transparent blending order still follows Three.js; this is not order-independent transparency.

Volume rendering separates reconstruction (`interpolation`: `Nearest`, `Linear`,
or `Cubic`) from integration quality (`stepSizeMultiplier`, relative to cell size,
bounded by `steps`). Opacity is distance-corrected so quality changes do not
silently act as density gain. `densityGain` is an explicit appearance multiplier.
`densityMapping` selects `Smoothstep` (existing `threshold`/`range`), `Linear`,
`Curve`, or `None`. All mappings normalize/clamp density between `minDensity` (default 0)
and `maxDensity` (default 1); `densityCurve` follows
`ValueByParameter<number>` and is sampled to a lookup texture. These controls
do not change source emission, dissipation, diffusion, or liquid dynamics.

Nullable `colorByTemperature`, `colorByDensity`, `colorBySpeed` and `colorByVorticity`
multiply `color` and the sampled field color. Nullable `opacityByTemperature`,
`opacityBySpeed` and `opacityByVorticity` multiply opacity. Null contributes white/one.
Density already drives opacity; `colorByDensity` uses the same min/max remapping.

On `WebGPURenderer`, `downsample: 2` renders at half width and height and reconstructs
using scene/volume depth to preserve silhouettes. Set `dynamicResolution: false` for
fixed downsampling. Otherwise measured GPU time can lower resolution further relative
to that fixed baseline. Neither setting changes along-ray integration quality. Automatic feedback uses rendering time;
compute-heavy simulation alone does not reduce volume image resolution. Ray-step and
samples-per-voxel edits update uniforms without rebuilding the raymarch material.
The renderer keeps at most two reduced-resolution targets (the current scale and one recent scale).
Disabling adaptation at full resolution releases those unused targets.

`await system.prepare(renderer)` can overlap optional renderer pipeline preparation with module
preparation without advancing emission or simulation. Volume rendering prepares its existing
provider fields for the captured camera/scene; unavailable fields retain first-use compilation.

Volume renderer children share their provider’s textures and raymarch. Each interval sums
transformed child density and weighted color before lighting and opacity integration.
Children add density and texture sampling work without allocating particle child buffers.

Gas simulation separates physical behavior from volume appearance. Optional
`ByTemperature` and `ByDensity` multipliers apply to `turbulenceNoiseStrength`,
`vorticityStrength`, `turbulenceNoiseFrequency`, and density/temperature/velocity/color dissipation.
The effective coefficient is the base multiplied by each present modifier. Omitted
modifiers skip evaluation; negative multiplier results clamp to zero. These use the
normal `ValueByParameter` rules: `[0.5, 2]` interpolates endpoints, functions define
curves, and a scalar `1` scales with the normalized parameter. Use `[1, 1]` for a
constant neutral multiplier.

`GasSimulation.temperatureRange` and `densityRange` (both default `[0, 1]`) normalize
physical specific temperature (heat mass divided by density) and physical density.
They are independent of renderer appearance ranges and min/max density remapping.
Decay remains `exp(-effectiveRate * deltaTime)`. Forces are applied before pressure
projection. Only independent local continuous coefficients support these modifiers:
solver iterations, timestep/grid/allocation policies and algorithm selection do not.
Variable diffusion/viscosity requires separate conservative shared-face treatment.

`start()` starts playback and resets the emission cycle, including when restarting a paused system. `pause()` freezes simulation. `stop(clearParticles)` stops emission and resets system time; surviving particles can continue moving on subsequent updates when they are retained. `destroy()` permanently releases owned resources. Removing a system from its scene performs temporary cleanup so it can be attached elsewhere. Call `destroy()` when you will no longer use it.

Continuous emission retains fractional spawn timing between updates. Each newborn simulates only the time after its birth within the current step; scheduled bursts retain their own times. Module `deltaTime` arguments are seconds available to the selected particle. `realtime` remains age in milliseconds, and `time` remains normalized age. Initialization hooks and spawn observers see age zero.

`substep` defaults to `true`. Display updates and `advanceFrames()` divide large simulation deltas using `substepDeltaTime`, which defaults to `1 / prewarmFPS` (24 FPS by default). Each substep includes emission, modules, spatial queries, collisions, lifecycle events, and owned subsystems. Renderer handoff and live environment capture occur after the final step. Set `substep: false` to integrate an interval once while retaining accurate birth ages.

`maxCatchup` defaults to `null`, which uses the larger of system duration and finite maximum initial emitter lifetimes. `Emitter.getMaxLifetime()` uses the shared `maxDynamicNumber` sampler for constants, ranges, sets, and functions. Functions sample normalized time using `ParticleSystem.Settings.GPU_DYNAMIC_VALUE_RESOLUTION`; these maxima are approximate and may miss peaks between samples. Opaque values with no readable finite samples return `null` and are ignored. The estimate follows runtime edits to duration and emitter definitions. Set `maxCatchup` to an explicit number of simulation-time seconds to override it. A separate internal safeguard limits work to 240 substeps per supplied interval.

When elapsed time exceeds either limit, emitter and source clocks advance across the discarded older interval without births, historical burst replay, or accumulated distance credit. Only the recent interval is simulated; continuous rates keep their fractional phase. This is approximate and does not reconstruct missed spatial interactions, modified lifetimes, or unobserved event chains. Pauses take precedence: paused updates advance the wall-clock baseline without simulating, and `start()` resets that baseline even when no updates occurred during the pause. `start()` continues to restart the emission cycle.

The loop duration schedules emission; it is independent of each particle's lifetime. Turning looping off does not necessarily delete existing particles: `endBehavior` determines what happens after the duration. A population estimate for constant emission is rate multiplied by average lifetime, before bursts, culling, or subsystems. These are nominal estimates: timestep quantization and emission scheduling can lower the observed count. Set `maxParticles` to bound simulation costs, and remember that each renderer adds work.

[Subsystems](subsystems.md) attach secondary effects to lifecycle events. [Spatial effects and collections](spatial-effects.md) coordinate scene-wide behavior. Both rendering backends use this same composition model; see [compatibility](compatibility.md) and [GPU processing](gpu-processing.md).

The exported `sampleDynamicValue(value, sample, resolution = 16)` reduces dynamic leaves using a custom `(a, b) => result` callback. It visits range endpoints and set members and samples functions over normalized time. `maxDynamicNumber` / `minDynamicNumber`, `maxDynamicVector` / `minDynamicVector`, and `maxDynamicColor` / `minDynamicColor` provide common reductions. Vector and color extrema are component-wise and return independent objects. These are sampled estimates for functions, not guaranteed mathematical bounds. Numeric helpers return zero for unreadable inputs unless an explicit third fallback argument is supplied; vectors return zero and colors return black. The generic reducer returns `undefined` when no readable leaf exists and accepts a fourth callback for input normalization.


`averageDynamicNumber` and `medianDynamicNumber` use the same readable-leaf traversal as
numeric min/max helpers: ranges visit endpoints, sets visit members, and functions sample
normalized time uniformly (16 samples by default). They accept a fallback for unreadable
values. These are sampled statistics, not guaranteed bounds or probability-weighted
expectations. The median averages the central pair for even sample counts.

Fluid motion forecasts and `automaticPaddingDistance` are vectors: each axis uses its measured
maximum velocity rather than the maximum speed on every axis. Gas also integrates sampled damping
and buoyant travel over a short lookahead; buoyancy adds vertical padding and diffusion adds isotropic
padding. The padded particle bounds are united with measured occupied gas afterward, so existing gas
is retained without forecasting its past travel again. There is no additional percentage growth margin.
The spatial grid then applies its centering, cubic shape, power-of-two rounding and configured ceiling.
An origin-centered eight-unit cube spans −4 to +4; support reaching +8 needs a sixteen-unit cube.
Representative averages alone cannot protect fast outliers, so measured support remains authoritative.

VolumeRenderer's nullable `densityNoiseStrengthByTemperature`, `densityNoiseContrastByTemperature` and
`densityNoiseFrequencyByTemperature` multiply their corresponding density-mask settings using the
renderer temperature range. They reuse the temperature already sampled for appearance,
change rendering only, and require WebGPURenderer like the procedural density mask itself.

## Volume self-lighting and scattering

`VolumeRenderer.emissive` blends the externally lit transported gas color toward its original color:
`mix(volumeColor * externalLighting, volumeColor, emissive)`. It defaults to zero, and the final factor
is clamped to `[0, 1]`. It does **not** emit light into the scene or LightingGrid. Use LightRenderer or
scene lights to illuminate nearby objects or other gas.

```ts
new VolumeRenderer({
  emissive: 1,
  emissiveByTemperature: heat => Math.min(1, heat * 2),
  emissiveByDensity: [0, 1],
  emissiveBySpeed: null,
});
```

`emissive` is a plain scalar number. Its separate temperature/density/speed ValueByParameter modifiers
use the same normalized ranges as the corresponding color/opacity controls. Their null defaults contribute one,
so enabling `emissive: 1` lets the modifiers shape it. The factors multiply before the final clamp.
As with other by-parameter controls, a numeric modifier scales its normalized parameter; `[1, 1]`
is a constant-one modifier. GasModule's `modifyRenderGPU` receives a mutable `context.emissive` node:
use `context.emissive.assign(...)` to override it procedurally. This never writes simulation storage.
The Volumetric Fire preset uses temperature primarily, with density suppressing self-lighting in thin wisps.

Anisotropy uses Henyey–Greenstein phase weighting at each ray sample: zero is isotropic, positive is
forward scattering and negative is backward scattering. LightingGrid bins point toward the light;
the camera ray points into the volume. Both are opposite their physical photon-travel/outgoing
vectors, so their dot product gives the correct sign. Anisotropy does not change stored radiance,
propagation, attenuation or emission. The zero case retains the pre-averaged isotropic sampling path.
The opposite-view fixture checks `-0.8`, `0` and `0.8` against the
[Blender convention](https://docs.blender.org/manual/en/2.81/render/materials/components/volume.html).
This is a qualitative convention comparison, not a numerical Blender render match.

### Flow-aligned density noise

`VolumeRenderer.densityNoiseStretch` compresses the density-mask coordinates along local gas velocity,
using the same projection as LiquidMaterial's velocity distortion. Zero (the default) preserves the
unstretched mask and skips the additional velocity sampling. The effective stretch is the scalar base
multiplied by nullable `densityNoiseStretchByTemperature`, `densityNoiseStretchByDensity`, and
`densityNoiseStretchBySpeed` modifiers, then clamped to `[0, 0.95]`. Null modifiers contribute one;
parameters use the same normalized ranges as appearance controls. Providers without velocity remain
unstretched. Like the procedural density mask itself, stretching requires WebGPU.

This is render-only flow alignment: it changes neither simulated density nor velocity. The existing
4D noise animation still controls temporal evolution; no separate transported noise field is created.
Fire uses little stretching at high temperatures to preserve flame flicker, with stronger flow-aligned
detail in the cool smoke.


### Liquid surface activity

`SurfaceRenderer.LiquidMaterial` derives its calm-to-active gradient, roughness and normal-detail curves
from local deformation and vorticity, rather than absolute speed. `flow.deformationRange` defaults to
`[0.5, 6]` and `flow.vorticityRange` to `[4, 20]`, both in inverse seconds. Their normalized values use
a bounded union. Uniform translation stays calm; shear/stretching and sufficiently strong curl activate
whitewater-style appearance. This is surface shading, not simulated foam or secondary emission.

The symmetric strain-rate magnitude and curl reuse one six-neighbor velocity stencil. Custom material
composition receives `context.surfaceDeformation`, `surfaceVelocity`, `surfaceSpeed`, `surfaceVorticity`
and `surfaceVorticityMagnitude`. The `surfaceVorticity` geometry attribute packs curl in XYZ and
scalar deformation in W. `flow.velocityRange` remains stored for custom artistic use; it no longer
drives the built-in activity. Physical velocity can still advect and stretch procedural normal detail.
`SurfaceRenderer.deformationDetailRange` separately controls activity-aware field filtering; the
older `velocityDetailRange` is retained but no longer drives the default filtering response.


Surface derivatives use a continuous support-confidence ramp below 5% of the visible isolevel.
A vanishing neighbor extends the center velocity rather than abruptly contributing a normalized
near-empty velocity. This is instantaneous spatial stabilization: there is no frame history or
temporal smoothing. Material deformation/curl remain full strength on supported surface samples.
Anisotropic reconstruction retains all contributors inside its compact kernel. Exact acceleration
may prune hash cells proven outside that support and skip already-converged eigen sweeps; it does
not change anisotropy according to visual activity or impose an arbitrary covariance-neighbor cap.
