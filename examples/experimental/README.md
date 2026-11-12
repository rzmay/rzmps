# Fluid implementation, performance and open issues

This is the maintained engineering note for GPU fluids and their renderers. It replaces the
separate investigation reports and surface-construction plans. Measurements below describe
specific local Chromium/WebGPU runs, not guaranteed frame rates.

## Responsibilities

- `FluidSimulation` is a particle module: shared fields, bounds policies, collider collection,
  pressure settings, preparation and particle appearance transport live here.
- `FLIPSimulation` transfers particle momentum to the grid, projects velocity and transfers it
  back, then performs density/separation and swept BVH collision work. Other modules still
  contribute forces and transient appearance. GPU processing is required.
- `GasSimulation` simulates persistent density, heat, color and velocity in `SparseVolumeGrid`.
  Particle scale defines source support; alpha weights the source contribution. Render-time
  transient values can update visual source contributions without advancing gas a second time.
- `ParticleSpatialGrid` indexes particle neighbors. `SparseVolumeGrid` shares grid geometry and
  addressing conventions but builds resident field pages from source/transport support.
  Brick and cell subdivisions describe two scales; they do not imply that every field is dense.
- `VolumeRenderer` discovers tag-overlapping volume providers through `getModules`, or uses
  explicit fields. It combines fields, performs density mapping/masking, and ray marches them.
- `SurfaceRenderer` reconstructs a visual particle field independently of the FLIP solver.
  `LiquidSurface` owns projection, support/covariance, filtering, extraction buffers, shading
  attributes and indirect draw arguments. It does not alter simulation pressure or positions.

The library's public API documentation remains the source for complete option signatures.

## Grid, pressure, boundaries and lifecycle

Grid structural setters invalidate/rebuild their structure. Grid options are configuration
objects, not preconstructed indices. Quality controls remain exposed in the editor; runtime
buffers, nodes, maxima and implementation flags are not tuning controls.

Bounds follow origin-centered quantized coverage with automatic prediction/padding. Gas uses
motion lookahead plus heat/buoyancy and dispersion estimates; liquid predicts particle travel.
`Ballistic`, `Kill` and `Contain` policies apply only when an explicit maximum domain cap is
reached. The liquid demo uses a 16-unit cap with `Kill`.

Pressure supports fixed iterations, optional minimum/maximum sweeps and tolerance gating,
warm starts, and asynchronous reduced diagnostics. New cells start with zero pressure;
compatible retained cells keep pressure. Diagnostics report residual, pre/post divergence,
executed sweeps, maximum velocity and non-finite counts. Tolerance gates GPU work rather than
synchronizing the CPU after every sweep.

The iterative pressure solver remains the gas default. Experimental shared sparse multigrid
converges well on controlled fixtures but has developed excessive velocity in evolving plumes;
it is not production-proven. Controlled 32-cubed curved-obstacle divergence fell from 14.711 to
5.628 with iterative projection, versus 0.800 with a V-cycle plus smoothing. That comparison
establishes convergence on that fixture, not a universal performance advantage.

Any positive sampled occupancy remains solid for conservative collision. Pressure uses
fractional face openings, estimated cell fluid volumes and rigid solid-face velocities.
Swept BVH particle collision and moving-wall velocity are separate responsibilities. Very thin
geometry and narrow curved passages remain limited by grid, baked-field and particle sampling.
Deforming geometry does not yet supply a full per-vertex wall velocity field.

`collisionOptions` opts simulations into scene collection using the physics backend's nested
membership API: world, static/dynamic roots, filters, geometry-dynamic classification and
update policy. Explicit lists, including empty lists, override discovery. Automatic wrappers
follow transforms/geometry revisions without reparenting or owning application geometry.
The demo teapot/floor and gas-flow meshes are discovered without explicit FluidCollider proxies.
Gas-emitting particles can still require a particle Collision module to avoid emitting past walls.

`await system.prepare(renderer)` uploads resources and compiles supported pressure pipelines
without advancing emission, age or simulation. An initialized native WebGPU renderer is required.
Some particle-count-dependent, reconstruction and material pipelines remain first-use work.
Catch-up work is bounded to four actual solver steps per update.

## Earlier corrective findings retained

Clear/restart previously failed when empty CPU renderer visits were rejected and freshly allocated
particle buffers reused cached version numbers. Empty clearing is accepted, while nonempty CPU
reconstruction is rejected. Transfer, gather and cap caches now track buffer identity as well as
version. Liquid projection also moved from mismatched centered derivatives/Laplacian to shared
face-based projection and staggered donor-normalized transfer. These fixes preceded surface V2.

The hidden-window visual improvement was not conclusively reproduced. A controlled single
0.5-second source step produced more heat/density than thirty small steps even without births
or transient overlays; cool-speed differences mostly disappeared two seconds later. Source
integration was bounded by remaining particle lifetime and velocity relaxation made exponential.
That is not proof of the reported sustained effect, and global visibility/emission timing was
not changed. Large transient position changes can still omit visual source candidates because
query candidates originate from the main particle positions.

The historical controlled study can still be run with
`node scripts/tests/preview/fluids/fluid-study.mjs /tmp/fluid-study` and the optional Blender
fixture `scripts/tests/preview/fluids/fixtures/blender-smoke.py`. Inspect Blender's evaluated
domain, rather than reading density on the original modifier. Old measurements establish
specific regressions, not parity with Blender or Niagara.

## Liquid reconstruction and custom extraction

The renderer separates `particleRadius` (default 1.55, times half the largest particle scale),
`influenceRadius` (2.2) and `isoLevel` (0.2). Compact poly6 support sums continuously. Bulk
amplitude compensates for support volume; isolated iso radii are calibrated separately.
`dropletSupportMin/Max` (1/4) blend isolated and bulk behavior. Isolated sub-voxel particles
receive a one-voxel sampling floor. This is not physical surface tension or exact volume conservation.

Optional covariance anisotropy shares the particle query index. Bounded principal stretches,
eigenvalue floors and insufficient-neighbor sphere fallback keep degenerate neighborhoods finite.
Anisotropy defaults off; the demo uses 0.35 with maximum stretch 1.5. Some sparse regular inputs
still develop internal cavities, so higher strength is not automatically better.

Optional closing and paired smoothing/compensation operate on scalar/color/momentum fields
before extraction. Support and flow attenuate filtering. Mesh Taubin smoothing is final cleanup.
Normals come from the outward implicit-field gradient at the final vertex position.

Choose `SurfaceExtraction.SurfaceNets` or `SurfaceExtraction.MarchingCubes`; enum strings remain
accepted as elsewhere in the library. The demo exposes this choice. The implementations live
in `buildSurfaceNets.ts` and `buildMarchingCubes.ts`, not in the resource-owning class.

Custom factories implement the exported `SurfaceExtractor` signature from `LiquidSurface`:

```ts
const customExtraction: SurfaceExtractor = context => {
  const pass = context.grid.compute(index => {
    // Sample context.field and write positions/indices using your extraction algorithm.
    // Atomically count requested triangles in counters[0], generated vertices in counters[1].
    // Guard all output writes against context.maximumTriangles.
  });
  return { nodes: [pass] };
};
const renderer = new SurfaceRenderer({ extraction: customExtraction });
```

Factories receive the sparse grid, scalar/color field, world mapping, iso threshold, output
buffers, topology scratch and smoothing strength. Default layout is triangle soup: three
consecutive vertices per triangle. Set `factory.vertexLayout = 'cells'` for one vertex per
sparse cell. Return ordered extraction passes, optional paired smoothing passes and an optional
`triangleMultiple` (two for Surface Nets quads). Valid position.w is one. The owner computes
flow/color/normals afterward, limits indirect draws, and disposes the returned passes. Changing
the function reference rebuilds resources. Built-in factories are exported for wrapping/reuse.

Velocity and curl are always reconstructed. `surfaceVelocity` stores velocity.xyz and support.w;
`surfaceVorticity` stores curl.xyz and magnitude.w. Existing GPU/GLSL material composition hooks
receive velocity, speed, vorticity, magnitude and support. Custom shaders can consume attributes
directly. Geometry reconstruction remains GPU-only; exported CPU geometry can use those same
attributes in WebGL materials.

The default `SurfaceRenderer.LiquidMaterial` extends Three.js's physical material and uses ordinary
composition callbacks. Explicit custom materials remain supported. Calm water
has subtle nonzero normal detail. Activity increases detail, stretches noise along velocity,
lightens color and broadens roughness. Two bounded advection phases hide resets. This is artistic
surface whitewater, not foam simulation. Opacity/transmission remains unchanged: the V2 spec
specified color/roughness/normal behavior but no activity-to-opacity mapping.

### Built-in liquid appearance

`LiquidMaterial` is exported directly and as `SurfaceRenderer.LiquidMaterial`. Omitting the
surface renderer's material selects it automatically. The renderer clones supplied materials,
including their flow settings; changing the renderer-owned material leaves the source intact.

```ts
const surface = new SurfaceRenderer({
  material: new SurfaceRenderer.LiquidMaterial({
    transmission: 0.9,
    flow: {
      gradient: ['#a8daed', '#f5fbff'],
      roughness: [0.025, 0.7],
      normalStrength: [0.045, 0.22],
      noiseFrequency: [3, 6],
      distortion: [0, 0.65],
      velocityRange: [0.2, 3],
      vorticityRange: [0.5, 8],
    },
  }),
});
(surface.material as LiquidMaterial).setFlow({ roughness: t => 0.025 + 0.675 * t });
```

`flow` color/roughness/normal/noise controls accept `ValueByParameter`, including endpoint pairs,
functions sampled with the shared GPU curve helper, and TSL nodes. The parameter is activity in
[0, 1]: speed and curl are each smoothly normalized by their range, then combined as
`1 - (1 - speedActivity) * (1 - curlActivity)`. Either fast translation or strong rotation can
activate the upper end. `gradient` multiplies particle color at rest and increasingly blends
toward the gradient itself in active regions. Particle color therefore remains meaningful.
Flow roughness overrides base physical roughness; transmission/opacity remain separate controls.
The stronger demo roughness range is 0.025–0.7, rather than its earlier narrow artistic adjustment.

Numbers follow existing `ValueByParameter` scaling semantics: `0.1` means `activity * 0.1`;
use `[0.1, 0.1]` for a constant. `setFlow` replaces settings and invalidates the composition
callback so appearance changes rebuild shader state without reallocating the reconstructed mesh.
GUI Flow Appearance edits call the same method, and code export preserves the built-in and curves.
An explicit `materialCompositeGPU` overrides the built-in appearance as for other custom materials.

## Gas appearance and secondary particles

Gas dissipation controls decay; dispersion transports/spreads gas rather than simply fading it.
Turbulence adds procedural velocity forcing, while vorticity confinement reinforces existing curl
lost numerically. Neither is a density mask. SemiLagrangian advection is the default; bounded
MacCormack is optional.

Volume interpolation supports nearest, linear and cubic B-spline reconstruction. Density gain,
range/curve mapping and opacity are visual controls. Opacity uses a fixed simulation-unit
reference, independent of grid size and ray spacing. Step size is sampling quality, not density.
Scene-depth clipping is on by default; opacity-aware adaptive stepping is off by default because
it can alias detail. No lower-resolution screen-space reconstruction is implemented.

The animated procedural mask uses the shared shader noise infrastructure. Its value is
`pow(clamp((noise - 0.5) * noiseContrast + 0.5, 0, 1), noiseStrength)`. Strength zero disables it.
Gas Volume uses 3+4 subdivisions, 300 particles/second, radial speed 1.5, shrinking sources,
strength 2 and contrast 1.5. Volumetric Smoke and Steam Burst are descriptive presets; their
historical Blender/Niagara inspirations do not imply physically identical parameters/results.

Volume renderer children are displaced/scaled field copies, sharing textures and adding density
without mass normalization or collision masking. They do not generate unused child particle
buffers. More children still cost more field samples.

The liquid demo's secondary sprites are spray, not persistent foam. A GPU `shouldEmitGPU` hook
and `FLIPSimulation.SprayCondition(...)` select fast/separated markers. Large translucent additive
sprites inherit velocity/color, fade in/out, slowly rotate and die on collision. True adhered
surface foam, bubbles and wetness remain deferred; no secondary fluid solve is implied.

## Performance evidence and remaining costs

Gas source masks and fused gathers removed repeated searches outside emitter support. A recorded
3+4-subdivision update improved from 18.93 to 4.02 ms GPU time; source-related work fell from
about 16.8 to 1.3 ms. A 2+4 case did not consistently improve, so this is not a universal speedup.
Controlled masked-versus-exhaustive tests match scalar, color, velocity and transient fields.

Sparse allocation releases pages and compacts free slots in parallel, then claims them in parallel.
The previous single-invocation free-slot search became expensive at capacity. In a recorded late
liquid workload, allocation-related fenced wall time dropped from about 21.5 to 3.2–3.9 ms.
A corrected 3,000-frame run retained a 16.7 ms median late interval at roughly 13,000 particles.
Those fenced spans include submission/synchronization and are not additive hardware timings.

Gas world-domain remapping reuses ping-pong buffers, cached graphs and uniform transforms.
Ordinary forced remaps measured roughly 1–4 ms CPU submission in one run. Resident pool growth
still changes strides/bindings and rebuilds pipelines; a measured growth update took 277 ms.
Prediction avoids that early event in Gas Volume but does not make arbitrary growth hitch-free.
Gas starts with 64 resident bricks and grows geometrically toward its configured maximum.
Sparse dispatch saves work; reserved fields and textures still cost startup upload and memory.

Surface memory/work depends independently on voxel size, kernel support, filtering halos, active
brick budget and triangle budget. Bounds caps do not cap occupied work. Owned-byte diagnostics
exclude driver/pipeline allocations. Both extractors share the reconstructed field and therefore
share its allocation failures. Overflow counters must be checked before diagnosing every hole as
an extraction seam. Saturated output budgets deliberately truncate output; they are not solver failures.

Controlled V2 reconstruction compared identical bulk, sparse blocks, droplets, sheets, jets,
splashes and a frozen/downsampled teapot snapshot. Surface Nets remains the default: it made the
jet connected and substantially smoothed the teapot, but retains some ambiguous configurations.
Classic Marching Cubes had open edges in several cases. Neither is universally watertight.
Filtered bulk volume changed about 1.5%; the downsampled teapot case grew about 16%. This is not
exact volume preservation, and snapshot comparison is not a sustained solver benchmark.

### What surface budgets actually reserve

These are **rendering capacities**, not solver parameters. `maxActiveBricks` caps resident pages
of reconstructed scalar/color/velocity/curl data, including filtering/extraction halos. Surface
bricks contain 8 cubed samples. Surface Nets also reserves cell-addressed vertex/topology scratch.
`maxTriangles` caps mesh index/output storage; Marching Cubes reserves three vertex records per
triangle, whereas Surface Nets shares cell vertices. Exceeding a cap counts overflow and omits
output. It can look like missing whole bricks or clipped patches even when the fluid solver is correct.

Defaults exist, so no initial manual sizing is required. They are fixed capacities today, however,
and dispersed/long-lived surfaces can need larger settings. The demo explicitly reserves 4,096
bricks and 524,288 triangles; these are not automatic, demand-based limits. Gas separately grows
its resident simulation pool from initial to maximum capacity. Neither setting limits particle count.
The surface voxel size and fixed coverage bounds determine possible sample locations, not how many
of those locations become occupied or how many crossing triangles particle kernels produce.

Automatic sizing/growth is feasible but is not implemented by this material pass. Reserving the
entire bounds cube would largely defeat sparsity. Demand-based growth would need extra capacity,
replacement output/field buffers and pipeline rebinding; it must avoid recreating the gas growth
hitch. The prior 417 MiB Surface Nets measurement illustrates the cost of simply raising the caps.
A geometric growth policy with reported maximum/device limits is a candidate for a separate pass,
not a silent change to current capacity semantics.

### Startup latency: measured cold-path breakdown

`startup-review.mjs` runs the actual gas/liquid factories and scenes with the same non-advancing
`system.prepare(renderer)` gate as the demo. It measures renderer init, scene load, construction,
initial empty render, preparation, first fixed update plus GPU fence, and the first populated
render. This starts after module imports; it excludes cold dependency downloads and GUI setup.
It measures the first populated render submission/completion, not perceptual visibility thresholds.

A local Chromium/native-WebGPU run after adding the built-in material measured:

| Phase | Gas Volume / Gas Flow | FLIP Fluid / Teapot |
| --- | ---: | ---: |
| Preparation | 941 ms | 1,379 ms |
| Collider baked-field CPU spans within preparation | 555 ms | 1,074 ms |
| Compute compile/preparation awaits within preparation | 360 ms | 214 ms |
| First update CPU submission | 246 ms | 1,315 ms |
| First update including queue fence | 345 ms | 1,362 ms |
| First populated render including fence | 4 ms | 41 ms |
| Total from renderer initialization to populated frame | 1,348 ms | 2,943 ms |

The cold liquid first update includes an **838 ms boundary-update compute call**. That call
includes TSL graph/pipeline/binding construction and initial resource work, not 838 ms of measured
GPU execution. Other first-use costs include G2P, field filtering, vertex shading, surface extraction,
and material compilation. Gas has first-use scalar transport and boundary/force pipelines as well.
The first subsequent liquid frame can still compile additional count-dependent variants before
settling, so the table is not a promise that every later first-use cost has been prepared.

Backend hooks measured buffer creation/upload submission and pipeline creation calls separately.
Their synchronous durations do not include all asynchronous compilation or deferred GPU work.
Liquid's large surface buffers contribute material allocation/upload cost, but they do **not**
explain the dominant measured collider baking and first boundary-pipeline setup. Preparation is
non-advancing; the demo intentionally waits for it before emission, which makes this work visible
as a delay rather than simulated time passing. Earlier local captures ranged around 1.35–1.69 s
for gas and 2.94–3.69 s for liquid, showing cold-cache/browser variation.

Next candidates are caching/reusing collider bakes, preparing the actual first-use boundary,
transfer and surface variants, and staging those tasks while preserving the non-advancing contract.
No startup optimization or automatic surface capacity change is claimed in this pass.

### Stratified volume sampling and directional lighting

The preferred path is now `samplesPerVoxel: 2`, `jitterStrength: 1`, `jitterSeed: 0`, Linear
interpolation, `anisotropy: 0`, and `shadowQuality: 0`. `steps` remains the maximum camera-ray
budget, capped at 512. A budget-limited ray increases its spacing to cover the complete visible
interval instead of truncating the far end. Each interval contributes its actual length to
extinction; jitter changes only the evaluation point, including the last partial interval.

Jitter uses a fixed obliquely scrambled simulation-space field and an irrational per-stratum
rotation. It has no frame, screen-coordinate or elapsed-time seed. It is a cheap decorrelated
low-discrepancy approximation, not a measured blue-noise texture spectrum. Moving a system root
carries its sampling pattern; changing rays traverses the same simulation-space field. Animated
density noise remains independent. No temporal reconstruction or history is introduced.
`jitterStrength` is clamped to [0, 1]. The older `jitter` boolean and reciprocal
`stepSizeMultiplier` remain code aliases; the GUI exposes Samples / Voxel and Jitter Strength.

The renderer resolves the dominant visible scene directional light, or accepts an explicit
`light`. With none, it uses a white unit light from a fixed direction. Incoming photon travel
and sample-to-camera direction determine HG scattering: positive anisotropy favors forward
scattering, negative favors backward scattering. Values clamp to [-0.9, 0.9]. The normalized HG
phase is artistically scaled by 4π so a unit isotropic light has unit directional response.
A fixed 0.2 ambient plus 0.8 directional weight preserves the previous isotropic fallback
brightness. The phase is evaluated once per ray, not repeatedly per sample. Extinction remains
separate from scattered radiance, leaving an insertion point for future emitted radiance.

`shadowQuality: 0` omits secondary marching on WebGPU and bypasses it on WebGL. Positive quality
uses cell-relative midpoint light samples, up to `ceil(quality * 8)` steps, bounded at 64. The
march always covers its remaining light interval. Only density textures are read; directional
radiance is attenuated by light transmittance while ambient remains. This is single-scattering
self-shadowing, not geometry shadow-map sampling or multiple scattering. The existing animated
density mask remains WebGPU-only, including its shadow extinction. New sampling and lighting
controls otherwise have equivalent GLSL/TSL semantics.

Both paths use Three.js material color/tone conversion. Linear render-target checks match the
new directional response exactly in the recorded 8-bit fixture. Transparent canvas results are
not pixel-identical: WebGL encodes/blends its direct output differently from WebGPU's output
pass. This is a remaining presentation distinction, not evidence of different HG/extinction
math. No renderer-wide compositing architecture was changed to hide that distinction.

A bounded frozen 32-cubed density-field benchmark at 480×320 used matched camera, 2 samples/voxel,
96 maximum steps, full jitter, no density noise and no opacity termination/adaptive stepping.
The center camera ray has 64 primary strata; quality 2 bounds each secondary march to 16 samples.
These counts are analytic counts/bounds, not instrumented totals over every screen pixel.
GPU timings span the first-to-last actual render-pass timestamp, avoiding sums of overlapping
Three.js contexts; fenced wall times measure render plus queue completion. Four measured renders
follow two warmups per configuration. Local GPU clocks/cache effects make sub-millisecond
comparisons noisy; these are not sustained gas-demo performance measurements.

| Interpolation | Anisotropy | Shadow quality | GPU ms | Fenced wall ms |
| --- | ---: | ---: | ---: | ---: |
| Linear | 0 | 0 | 0.772 | 1.000 |
| Linear | 0.5 | 0 | 0.452 | 0.700 |
| Linear | 0.5 | 2 | 1.860 | 2.100 |
| Cubic | 0 | 0 | 0.407 | 0.700 |
| Cubic | 0.5 | 2 | 3.890 | 4.200 |

Linear needs one hardware-trilinear density evaluation per logical sample. Cubic already groups
B-spline weights into **eight** trilinear evaluations on both backends; it is not a naïve 64-read
implementation. With a color field, a primary sample normally doubles those counts to 2 / 16
per contributing layer; child copies and multiple fields multiply them further. Shadow samples
read density only. This cache-friendly fixture does not reproduce the reported 60-to-15 FPS
cubic regression. Larger working sets, color fields, repeated layers and light marches can make
its eightfold texture cost much more significant. Linear remains the default; no claim is made
that cubic is universally cheap or that its reported full-demo slowdown has been eliminated.

`volume-sampling.test.mjs` validates constant-density invariance at 1/2/4 samples per voxel,
centered/full jitter and a one-step cap, static repeatability, positive/negative HG direction,
isotropic symmetry, shadow attenuation, and linear-target backend parity. It saves six oblique
frozen-field captures for sampling review. Those smooth synthetic captures are not a guarantee
that every high-frequency gas/noise configuration is free of visible banding.

## Current corrective work and open issues

- Missing whole bricks during tipping were reproduced as surface-pool exhaustion: the old 2,048-page
  budget rejected 2,740 requests in the late capture. Support marking now bounds the *blended*
  anisotropy stretch rather than the full configured stretch, and requests only the enabled
  scalar-filter halo plus one extraction sample. The demo uses 4,096 bricks and 524,288 triangles.
  A separate corrected 2,100-frame run had 2,712 live bricks and zero overflows. Reconstructing
  its final source state with both methods used 2,686 bricks: Surface Nets emitted 97,164 triangles,
  Marching Cubes 91,868, with zero brick/triangle overflow for either. These independent evolving
  runs are not matched-state before/after quality measurements. Diagnostics are now captured
  before destructive per-stage timing replay, which otherwise inflated triangle counters.
  The corrected run reserved about 417 MiB for Surface Nets and 369 MiB for Marching Cubes;
  larger coverage has a real memory cost. The last 600 frames had a 16.6 ms median interval
  at 13,182 live markers in this local run. The budgets remain finite; more dispersed/longer-lived
  scenes can still exhaust them. Support crossing fixed outer bounds is counted separately as
  `clippedParticles`, even when its intersecting portion is still reconstructed.
- Narrow spout flow can still be under-resolved despite triangle clearance. Fractional faces and
  moving-wall pressure improve the model, but pressure residuals, particle size and boundary
  sampling must be measured separately before claiming physical viscosity or a solved outlet.
- Multigrid stability on evolving sparse plumes remains unresolved; keep iterative default.
- Cold preparation and first-use work delay visible emission by seconds; the measured breakdown is above.
- Gas capacity growth can hitch. Fully staged replacement resources would need a separate lifecycle.
- Robust topology (MC33/asymptotic decisions or topology-aware dual extraction), exact surface-volume
  control, temporal reconstruction and persistent surface foam are separate projects.
- Strong high-frequency density masking can alias when ray samples are insufficient. No temporal
  or depth-aware screen-space upsampling is implemented.

## Reproduction

```sh
npm test --workspace @rzmps/rzmps
node scripts/tests/preview/fluids/surface-v2.test.mjs
node scripts/tests/preview/fluids/surface.test.mjs
node scripts/tests/preview/fluids/surface-quality-review.mjs
FLUID_PRESETS='FLIP Fluid' RUNTIME_FRAMES=2100 node scripts/tests/preview/fluids/runtime-performance.mjs /tmp/fluid-runtime
node scripts/tests/preview/fluids/gas-stage-profile.mjs /tmp/gas-stages
node scripts/tests/preview/fluids/startup-review.mjs /tmp/fluid-startup
node scripts/tests/preview/fluids/volume-sampling.test.mjs /tmp/volume-sampling
```

The surface quality script saves matched screenshots, particle snapshots, topology, volume,
overflow, buffer-byte estimates and timings. Queue-fenced times are distinct from hardware GPU
timestamps; unsupported timestamp metrics are null. Browser diagnostics are explicit tools,
not per-frame readbacks added to ordinary rendering.

## Validation for this corrective pass

The full library build, type checks and test suite pass. Native surface regressions pass for
both built-ins, custom factory wrappers/replacement, page-aligned translation, flow/color
interpolation, mesh smoothing, empty/reused systems, tag/child/transient inputs, capacity recovery
and material serialization. The serializer now retains physical water properties such as
transmission, thickness, IOR and attenuation. Touched-file lint and the 120-character checks pass.
The late interactive capture reports no browser errors or non-finite solver samples. This does
not replace the unresolved topology and long-duration capacity limitations above.

## Design references

- [Obi fluid rendering and realtime Surface Nets](https://obi.virtualmethodstudio.com/manual/7.0/fluidrendering.html)
- [Blender liquid mesh controls](https://docs.blender.org/manual/en/4.5/physics/fluid/type/domain/liquid/mesh.html)
- [Niagara fluids reference](https://dev.epicgames.com/documentation/en-us/unreal-engine/niagara-fluids-reference-in-unreal-engine)
- [Unity volumetric density controls](https://docs.unity3d.com/Packages/com.unity.render-pipelines.high-definition@17.0/manual/Override-Fog.html)

These are design references from earlier investigations, not claims of exact parity or new
comparative measurements in this surface corrective pass.
