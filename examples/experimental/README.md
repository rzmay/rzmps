# Fluid implementation, performance and open issues

This is the maintained engineering note for GPU fluids and their renderers. It replaces the
separate investigation reports and surface-construction plans. Measurements below describe
specific local Chromium/WebGPU runs, not guaranteed frame rates.

The current [bounds predictor](#automatic-bounds-and-directional-padding-current-implementation) and
[recorded stage timings](#current-recorded-startup-and-baking-measurements) below supersede older
scalar-padding descriptions and startup figures retained as historical comparisons. Internal timing
results are included here at the user's request; the internal runner remains separate from published
benchmark tables and automated PR benchmark reporting.

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

## Automatic bounds and directional padding: current implementation

The relevant implementations are `FluidSimulation.refreshBounds`, `GasSimulation.readAutomaticPadding`,
`GasSimulation.estimateBuoyantTravel`, `FLIPSimulation.readAutomaticPadding`,
`ParticleSpatialGrid.readParticleMetrics`, and `SpatialGrid.normalizeBounds`.
All distances and velocities below use the system's simulation coordinates. Padding is an **axis-wise,
symmetric Vector3**: `(px, py, pz)` expands both faces of each axis. It is not six independently signed
face distances. The fluid solvers still require cubic, power-of-two cells/domains; a smaller horizontal
prediction does not make the final domain rectangular when its vertical extent determines the cube.

### Inputs and when they are observed

| Input | Exact source and treatment |
| --- | --- |
| Particle support `P` | GPU minima/maxima of live particle centers, expanded on every axis by the largest live radius. Radius is half the largest absolute component of particle scale. Empty populations produce an empty box. |
| Particle velocity `Vp` | Component-wise maximum absolute `particle.velocity * particle.speed`; maxima can come from different particles. Packed render snapshots have no separate speed channel, so their available velocity is used directly. |
| Existing gas support `G` | Physical cells with `density > 0` and `density >= densityCutoff`; minima use cell coordinates and maxima use coordinate plus one, so the box includes complete occupied cells. The captured grid minimum and cell size convert coordinates back to simulation space. |
| Maximum gas density `D0` | Maximum nonnegative density across active solver cells. This is physical density, before renderer remapping or masking. |
| Maximum specific temperature `T0` | Maximum `max(heatMass / max(density, 1e-6), 0)` across active cells. This and `D0` need not belong to the same cell. |
| Gas velocity `Vg` | Component-wise maximum absolute projected velocity over cells included in `G`. A separate peak velocity magnitude is also recorded, but is not used for directional padding. |
| Lookahead `L` | `max(velocityPaddingLookahead, 0)` seconds. Gas defaults to 1 second; FLIP defaults to 0.5 seconds. It is independent of particle lifetime and gas decay lifetime. |
| Manual margin ratio | `boundsPadding`, default 0.25, applied to the largest particle-support side, with a minimum reference side of one unit. |
| Physical behavior | `velocityDissipation`, `densityDissipation`, `temperatureDissipation`, their present `ByTemperature`/`ByDensity` modifiers, plus `buoyancy`, `weight`, `maxVelocity`, `scalarDiffusion`, `densityCutoff` and captured gas cell size `h`. |
| Domain policy | Current bounds, `automaticPadding`, `spatialGridOptions.autoShrink`, `shrinkDelay`, `centeredAtOrigin`, `maxBounds`, and the fluid `boundsPolicy`. |

The existing particle-grid reduction supplies particle support and axis velocities in one readback.
Gas reduces its physical fields every transport step into 12 words: density, temperature, three lower
coordinates, three exclusive upper coordinates, peak speed, and three axis speeds. The bounds poll
reads that small buffer; it does not download all field cells. These are asynchronous observations,
not a synchronized snapshot of every particle and gas quantity at exactly the same instant.

`refreshBounds` starts at most one read at a time and no more often than once per 500 ms of wall time.
Results from a replaced grid or changed bounds generation are discarded. Accepted results become
`pendingBounds`; the next module preparation applies them to the particle index and solver together,
updates `cellSize = side / resolution`, and starts the algorithm's bounds-change/remapping path.

### Decay rates used by the gas forecast

For each required rate `r` (velocity, density, temperature), the CPU predictor calculates:

```text
r_effective = max(baseRate, 0)
              * mean(max(ByTemperature(t), 0), t = 0/15 ... 15/15), if present
              * mean(max(ByDensity(t), 0), t = 0/15 ... 15/15), if present
```

Each modifier is evaluated through `evaluateByParameterNumber` at 16 uniformly spaced normalized
parameter values, including both endpoints; an unreadable mean falls back to one. An absent modifier
does not enter the product. Numeric ValueByParameter inputs scale with `t`, so literal `1` has mean
0.5; `[1, 1]` is a constant neutral modifier. These are representative full-range means, not a median,
an occupancy-weighted mean, the decay of the hottest cell, or a lifetime integral along each particle.
Separate modifier means are multiplied; correlated density/temperature behavior is not integrated jointly.
The GPU solver still evaluates the actual local coefficients in each cell.

### Gas prediction equations

Existing velocity is integrated with exponential damping over the lookahead:

```text
M = (1 - exp(-r_velocity * L)) / r_velocity    when r_velocity > 1e-6
M = L                                       otherwise
motion[i] = max(Vp[i] * L, Vg[i] * M)
```

Particle motion keeps its ballistic estimate because gas velocity damping does not necessarily apply
to the emitting particles. If `D0 <= 0`, the automatic padding is simply `motion`.
Otherwise the predictor estimates additional upward travel with a small CPU recurrence:

```text
dt = 1/60
D = D0; H = T0 * D0; v = 0; B = 0
repeat while D > densityCutoff, for at most min(600, ceil(L / dt)) steps:
    temperature = H / max(D, Number.EPSILON)
    a = max(temperature * buoyancy - D * weight, 0)
    v = min(maxVelocity, v * exp(-r_velocity * dt) + a * dt)
    B += v * dt
    D *= exp(-r_density * dt)
    H *= exp(-r_density * dt) * exp(-r_temperature * dt)

F = h * sqrt(max(scalarDiffusion, 0) * L)
automaticPaddingDistance = max_componentwise(motion, (F, F + B, F))
```

`B` is an upward-distance estimate, although symmetric padding reserves it below the source as well.
`F` is an approximate cell-scale diffusion reach, not a physical diffusion PDE solution. The recurrence
is bounded to ten seconds and can round the requested lookahead up by less than one 1/60-second step.
Motion and buoyancy/diffusion are combined with a maximum, not added together. No full-hot-cell
decay-lifetime travel estimate remains.

Source temperature/lifetime curves, particle alpha, mass, source strength, turbulence, vorticity,
external forces and spatial affectors affect the measured physical fields and velocities. They are
not separately integrated as future forces by this predictor. Color dissipation, renderer opacity,
density noise, renderer children, raymarch settings and surface triangle budgets do not enter it.
Peak density/temperature from different cells and unweighted decay means can overestimate travel;
future acceleration, fast outliers between polls and the maximum rather than sum can underestimate it.
This is a rolling approximation, not a mathematical containment guarantee.

### FLIP and common domain construction

FLIP uses `automaticPaddingDistance[i] = Vp[i] * L`. It does not run the gas recurrence or forecast
buoyancy/diffusion. Gravity, subsequent forces and moving colliders are represented only insofar as
they have already changed particle velocity. There is no separate persistent gas-support box for FLIP.

Both algorithms then use the same construction:

```text
manual = max(P.size.x, P.size.y, P.size.z, 1) * boundsPadding
padding = max_componentwise(automaticPaddingDistance, (manual, manual, manual))
candidate = expand P by padding on both faces of each axis
candidate = union(candidate, G)               for gas with nonempty existing gas support
target = spatialGrid.resolveBounds(candidate)
```

Existing gas is united **after** particle prediction. Padding the union again would repeatedly
forecast travel from gas that has already moved, causing a growing envelope. The old extra 25%
prediction guard is also gone; the manual margin is a minimum, not an additional sum. The diagnostic
`automaticPaddingDistance` displays the automatic vector before that manual minimum is applied.

For origin-centered cubic domains, the required unquantized side is
`2 * max(abs(candidate.min.x/y/z), abs(candidate.max.x/y/z))`. The side rounds upward to the next
power of two, with a small tolerance for floating-point values near an exact power. A finite
`spatialGridOptions.maxBounds` is rounded downward to a power of two and clamps that side. With
`centeredAtOrigin: false`, the grid instead centers on the candidate box and uses its largest side.
The library keeps particle-grid GPU auto-expansion disabled for fluids so it cannot independently
disagree with the solver's domain.

Automatic growth is requested when the current domain does not contain the unquantized candidate.
Shrinking requires a target side below 75% of the current side for
`max(1, ceil(shrinkDelay / 30))` consecutive accepted polls, and `autoShrink` must be enabled.
At the nominal 500 ms poll interval, default `shrinkDelay: 600` means approximately ten seconds;
180 means approximately three seconds. These are bounds polls/wall time, not an exact count of
simulation frames. A `Contain` domain that has reached its finite cap does not shrink away those walls.
With `automaticPadding: false`, polling still updates diagnostics, but it does not resize from support.
Explicit initial bounds are padded/normalized at construction and can subsequently adapt when enabled.

The reported example `particle max Y = 3`, `padding.y = 5` reaches `Y = 8`, so an origin-centered
16-unit cube (`-8...+8`) is required, not an eight-unit cube (`-4...+4`). Repeatedly padding detached gas
and adding the old growth guard could push that requirement past eight and round the side up to 32.
In the latest 15-second smoke check, the domain stayed at `[-8,+8]` on each axis; existing gas reached
above Y=5 while source particles stayed lower. An eight-unit cube would therefore crop actual gas.
Regression checks also cover shrinking a 32-unit domain around four-unit persistent support without
forecasting that support again, and retaining a 16-unit domain for the explicit Y=3/padding=5 case.

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
it can alias detail. `downsample` explicitly selects screen-resolution reduction (1/full, 2/half, 4/quarter).
`dynamicResolution` can adapt further; disable it for fixed quality. WebGPURenderer reconstructs
with scene/volume depth and premultiplied filtering. These settings do not change voxel resolution.

The animated procedural mask uses the shared shader noise infrastructure. Its value is
`pow(clamp((noise - 0.5) * densityNoiseContrast + 0.5, 0, 1), densityNoiseStrength)`.
Strength zero disables it. Simulation noise uses the distinct `turbulenceNoise*` controls.
Volumetric Fire and Volumetric Smoke own their configurations independently; historical
Blender/Niagara inspirations do not imply physically identical parameters/results. Renderer `color`
multiplies the transported particle color, so white source particles preserve the renderer's tint.

Volume renderer children are displaced/scaled field copies, sharing textures and adding density
without mass normalization or collision masking. They do not generate unused child particle
buffers. More children still cost more field samples.

The liquid demo's secondary sprites are spray, not persistent foam. A GPU `shouldEmitGPU` hook
and `FLIPSimulation.SprayCondition(...)` select fast/separated markers. Large translucent additive
sprites inherit velocity/color, fade in/out, slowly rotate and die on collision. True adhered
surface foam, bubbles and wetness remain deferred; no secondary fluid solve is implied.

## Performance evidence and remaining costs

### Current recorded startup and baking measurements

The following are retained observations from the internal runner on 2026-11-13, Chrome
154.0.8037.57/native WebGPU. Each case has **one sample**, not a median or a sustained-performance
claim. The runner did not record the GPU adapter identity or a complete immutable preset snapshot.
Numbers therefore identify costs in these runs, not a hardware-independent budget or a controlled
before/after comparison. Earlier measurements below use other configurations and implementations.

Source captures were `/tmp/rzmps-fluid-internal.json` (all cases) and
`/tmp/rzmps-spatial-internal.json` (a subsequent isolated effect-bake sample). The tables preserve
the useful values here because temporary JSON files are not durable repository artifacts.
Reproduce explicitly, without updating public or PR benchmark output:

```sh
npm run benchmark:fluid:internal -- --samples 3 --output /tmp/fluid-stages.json
# Optional isolation: --case startup, --case colliders, or --case effects
```

**Timing interpretation:** CPU spans include graph building/first-use submission overhead.
`compileComputeAsync` wall times include asynchronous preparation and driver/compiler work.
Fenced elapsed times include CPU submission, GPU queue wait/completion and scheduling; they are
not pure GPU execution times. A fenced update includes its CPU submission row. Nested benchmark
spans and concurrent preparation calls overlap, so adding every row would double-count work.

#### Gas startup: actual factories, Checkerboard scene, 800×600

The startup fixture uses the actual smoke/fire factories, a 1/60-second display update and the
non-advancing `system.prepare(renderer)` gate. Imports, cold module downloads, GUI construction
and browser navigation are outside the measured interval. The populated frame is a submitted and
completed render, not a perceptual visibility threshold. Both gas presets use 3+4 subdivisions
(128 cells per axis) with an initial 64-brick resident pool. Fire additionally owns light and heat
distortion renderers/subsystems, so its whole-system first update is not gas-only work.

| Phase, ms | Volumetric Smoke | Volumetric Fire |
| --- | ---: | ---: |
| WebGPU renderer initialization | 20.0 | 37.0 |
| Scene construction | 0.4 | 0.4 |
| Particle-system factory | 8.3 | 12.8 |
| Initial empty render | 41.4 | 35.7 |
| Resource preparation, elapsed | 398.0 | 365.0 |
| First update, CPU | 223.8 | 333.4 |
| First update, including queue fence | 402.1 | 426.3 |
| First populated render, including fence | 4.7 | 56.2 |
| Renderer initialization through populated frame | **875.4** | **934.0** |

The preparation compute-compilation awaits break down as follows. Renderer material preparation
also overlaps this interval; the table is not an exhaustive additive decomposition of preparation.

| Prepared compute group, elapsed ms | Smoke | Fire |
| --- | ---: | ---: |
| Boundary representation, 1 node | 15.9 | 16.0 |
| Pressure/projection, 12 unique nodes | 292.1 | 264.1 |
| Bounds remapping, 2 nodes | 6.9 | 6.6 |
| Storage creation CPU spans, 41,922,040 bytes per case | 0.8 | 1.2 |

The first display update still builds/submits other first-use work. The captured stage spans below
are **CPU milliseconds summed across that first update**, including repeated solver steps, not GPU
times per steady frame. Smoke recorded two transport/projection calls and fire four. Their complete
startup traces contain 153 and 318 compute submissions respectively. These count calls, not unique kernels;
preparation itself compiles without advancing the solver.

| First-update stage, CPU ms | Smoke | Fire |
| --- | ---: | ---: |
| Scalar advection, diffusion and decay | 73.2 | 65.5 |
| Velocity advection, buoyancy and turbulence | 28.4 | 28.7 |
| Density/temperature/color source injection | 11.5 | 11.4 |
| Volume field export, including visual export visits | 11.1 | 8.4 |
| Sparse brick activation | 5.2 | 5.8 |
| Velocity source injection | 5.2 | 5.7 |
| Vorticity confinement | 4.5 | 4.6 |
| Curl | 2.5 | 2.4 |
| Pressure solve submission | 0.8 | 1.2 |
| Solid scalar constraints | 0.6 | 0.6 |
| Boundary update in this scene | <0.1 | <0.1 |

The enclosing `compute` spans were 159.1/151.7 ms and overlap child stages; they are not another
cost to add. Emission, particle processing, subsystem initialization and unlabelled work account
for further first-update CPU time. In particular, **0.8/1.2 ms pressure submission does not establish
that pressure takes that little GPU time**. The current startup capture has no separate timestamp
duration for every GPU stage, nor a warmed full-preset steady-state stage decomposition.

These captures place substantial startup cost in asynchronous pressure preparation and first-use
scalar/velocity graph submission. Storage creation's approximately one millisecond of CPU work does
not explain the hundreds of milliseconds of preparation by itself. Fire's 56.2 ms populated render
also includes its extra renderers; this capture does not isolate raymarch-only cost from distortion.

#### Fluid collider baking: 16³ occupancy samples

The fixture measures binary occupancy for a box, a 12×8-segment sphere, and
`utah_teapot_quad.obj`. Teapot shell thickness is 0.02 local units; the box/sphere use zero.
External OBJ loading occurs before the bake timer. Whole-bake completion includes GPU readback.

| Bake component, ms | Box | Sphere | Teapot |
| --- | ---: | ---: | ---: |
| CPU geometry classification | 0.5 | 0.2 | 6.0 |
| CPU BVH packing | 6.0 | 0.8 | 2.5 |
| GPU bake submission, CPU span | 5.7 | 0.9 | 1.5 |
| Whole bake CPU submission | 13.4 | 2.0 | 10.1 |
| Whole bake through readback | **18.5** | **5.4** | **17.8** |

Classification and packing occur before submission; the whole-bake CPU row includes them.
The bake's internal submission-to-cache-completion intervals were 11.1/4.3/9.2 ms; these overlap
submission and readback and must not be added to whole-bake completion. Lookup rounded to 0.0 ms.
Shared geometry, rigid-transform reuse, compact-cache upload and geometry-edit invalidation passed
for all three shapes; these checks did not separately time every cache operation.

The two-system shared-box fixture reused the same baked field across simulation lifetimes:

| Shared-geometry system phase, ms | First owner | Second owner |
| --- | ---: | ---: |
| Entire system preparation | 276.2 | 263.0 |
| Boundary pipeline compilation within preparation | 9.1 | 5.6 |
| First boundary submission | 0.3 | 0.2 |
| First boundary update including fence | 1.1 | 0.8 |

This small fixture uses a 1+2-subdivision gas grid and an eight-brick pool without optional pressure
diagnostics. It demonstrates bake reuse, not the complete teapot demo's startup cost. The second
owner's preparation still includes its own simulation pipelines despite sharing the geometry bake.

#### Custom spatial-effect inclusion baking and GPU use

A 384-triangle torus knot, feather 0.25 and 16³ inclusion texture isolates a custom effect.
The GPU test samples 64 positions. Inclusion-field **baking is currently CPU work**; field upload,
shader compilation and subsequent effect sampling use WebGPU. Transform-only edits reuse the bake.

| Phase, ms | All-cases sample | Later isolated sample |
| --- | ---: | ---: |
| Cold CPU inclusion bake | 51.2 | 36.6 |
| Cached CPU bake lookup | 0.1 | 0.1 |
| Rigid-transform update | 0.1 | <0.1 |
| Texture upload CPU submission | 0.4 | 0.4 |
| Texture upload including fence | 2.5 | 2.1 |
| Compute pipeline compilation, elapsed | 5.8 | 6.1 |
| First sampling dispatch CPU submission | 0.3 | 0.2 |
| First sampling dispatch including fence | 0.9 | 0.8 |

The two columns are separate single observations, not before/after results. Upload and dispatch
fenced rows include their CPU rows. The measured cold CPU bake is the largest component in this
small effect fixture; no GPU inclusion-bake implementation or optimization is implied.

#### Liquid timing coverage and remaining measurement gap

The latest internal runner measures **gas startup plus shared fluid collider/effect infrastructure**;
it does not yet provide a current full-FLIP startup or warmed liquid GPU-stage breakdown. Historical
`/tmp/rzmps-fluid-startup-final/metrics.json` does contain the teapot FLIP factory's older first-use
measurements, matching the historical startup table below:

| Historical FLIP phase, CPU ms unless stated | Recorded time |
| --- | ---: |
| Preparation, elapsed | 1,378.5 |
| Collider CPU baking within preparation | 1,074.4 |
| First boundary update/graph submission | 838.0 |
| Grid-to-particle transfer | 74.0 |
| Surface mesh update, enclosing span | 51.5 |
| Field filtering | 46.0 |
| Surface field reconstruction | 36.7 |
| Surface extraction | 26.4 |
| Surface smoothing | 21.3 |
| Anisotropy | 19.8 |
| Separation | 9.6 |
| Surface brick activation | 3.4 |
| Particle-to-grid transfer | 3.3 |
| Surface vorticity, two visits | 3.1 |
| Pressure submission | 0.6 |
| Entire first update, CPU | 1,315.4 |
| Entire first update, including fence | 1,361.8 |
| First populated render, including fence | 41.3 |
| Initialization through populated frame | 2,942.9 |

These liquid figures **predate the later GPU collider-baking and boundary-compilation corrections**.
They locate historical first-use bottlenecks and must not be presented as current liquid timings.
The enclosing compute span (937.7 ms) and mesh-update span overlap other work; rows are not additive.
Five subsequent update-plus-render fenced samples were 898.8, 34.1, 18.4, 17.9 and 17.9 ms, showing
additional first-use work after the nominal first populated frame. They are not a sustained benchmark.

For a current simulation-versus-render decision, remaining measurements are warmed GPU timestamps
per source gather, transport, pressure, collision and reconstruction stage, plus raymarch-only cost
at a controlled viewport, active-brick count and particle count. `gas-stage-profile.mjs` provides
dedicated per-stage GPU profiling and ray-quality comparisons; its historical figures elsewhere in
this report must not be substituted for an unrecorded current configuration. No current exact GPU
duration is claimed for a stage measured here only on the CPU or behind a whole-update fence.

### Historical performance baselines

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

Default surface capacities now grow automatically from a modest initial reserve. `maxActiveBricks`
and `maxTriangles` are expert hard ceilings; omission derives ceilings from device limits and logical
coverage. The demo no longer sets manual budgets. Gas uses the same staged lifecycle for its resident
simulation pool. Neither limit controls particle count. Surface voxel size and coverage bounds determine
possible sample locations, while live demand determines residency and output capacity. Geometric growth
prepares independent replacements and rebinds at a safe frame boundary; temporary old-plus-new memory
is a real cost. See the current-pass measurements below rather than the historical fixed-budget figures.

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
  scalar-filter halo plus one extraction sample. That measurement used 4,096 bricks and 524,288 triangles; current defaults grow automatically.
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
- Gas and liquid surface replacements use the shared staged allocation lifecycle. The focused growth
  measurements below exercise this path; asynchronous preparation does not guarantee zero CPU stalls in every scene.
- Marching Cubes now uses canonical face asymptotic decisions, retaining its classic fast path elsewhere.
  Deliberately ambiguous-face topology/timing coverage now passes. Full MC33, exact surface-volume
  control, temporal reconstruction and persistent surface foam remain separate projects.
- Strong high-frequency density masking can alias when ray samples are insufficient. No temporal
  accumulation is implemented; dynamic depth-aware screen-space reconstruction is available.

## Current correctness, lifecycle and rendering pass

Gas, liquid transfer and surface reconstruction remain GPU-only. The iterative pressure solver and
Surface Nets remain defaults. No new solver, AMR, temporal accumulation, persistent foam or APIC was added.

### Presets and renderer configuration

Volumetric Fire (`volumetricFire`), Volumetric Smoke and Steam Burst are independent factories. Smoke/steam
own their emitters, modules, collider options and volume settings; neither inherits fire colors or lights.
Only fire supplies temperature-driven flame colors. Each preset preserves the current scene selection.

`VolumeRenderer.colorByTemperature`, `opacityByTemperature`, corresponding speed/vorticity
properties and `colorByDensity` default to **null**. Null bypasses evaluation and contributes neutral white/one to the product.
GPU evaluation reuses the library's normal `ValueByParameter` bindings, including GPU nodes and live
uniforms; WebGL uses CPU-evaluable ramp tables. Literal values follow normal parameter-scaling rules;
use `[value, value]` or a constant function for a constant multiplier. There are no per-ramp enable flags.
Physical temperature, density, transported particle color and dissipation remain simulation concerns;
temperature/speed/vorticity-driven appearance belongs to the renderer.

`system.updateRenderers()` refreshes current rendering configuration without supplying a new particle
population, emitting, executing simulation/transient modules, or advancing time. It reuses the last GPU
render buffers (including existing transient output). Normal paused updates invoke it automatically.
Affected shader structures rebuild on the next scene render; ordinary uniform edits keep their pipelines.
The pause regression changes opacity and ray-step count while checking unchanged time and field version.

### Collider lifetime and hydrostatic pressure

GPU collider fields use the existing geometry BVH and a geometry-owned local occupancy cache. Box,
sphere, open-plane shell and Utah teapot cases cover binary occupancy, shared GPU reuse, rigid transforms,
compact-cache reupload and vertex revision invalidation. Two actual gas systems also reuse one unchanged
geometry bake. Timing separates lookup, closure classification, BVH packing, submission/completion,
cache upload, boundary compilation and the first boundary dispatch/fence. Cache completion includes its
asynchronous readback; it is not an isolated GPU timestamp.

The opened-vessel test exposed stale collision bindings: geometry membership changed but dependent
collision pipelines retained the previous topology. The backend now publishes a structural resource
version, and collision modules invalidate their pipelines when it changes. The backend's existing proxy
query graph remains stable for refits and rigid transforms. Fluid boundary topology changes invalidate
pressure warm starts; pending gas replacements referencing old boundary fields are cancelled.
The gas-removal regression verifies blocked cells fall to zero after the collider leaves the scene.

The communicating-vessel test now runs **real P2G classification, MAC projection, G2P, gravity and BVH
particle collision**, in addition to the isolated exact-domain pressure fixture. At 16 cells per axis,
4,032 markers and a two-cell passage, the sealed 0.8-second phase reaches RMS speed about 8.3e-6 and
reservoir/riser surface heights agree to about 4e-6 world units. Opening the lower outlet produces 87
outlet markers, zero higher-rim markers and zero floor leaks in the next 0.8 seconds. Sampled MAC outlet
flux is positive (peak about 0.23 volume units/second; integrated volume about 0.025). The isolated
pressure gradient is 0.9986 of the expected hydrostatic discretization. The hard liquid-classification
threshold was not changed: the demonstrated blockage was in collision lifetime/binding, not that threshold.
These are bounded synthetic results, not a claim of exact volume conservation or universal spout resolution.

FLIP also discards stale dense-grid pressure when bounds change: old cell addresses represent different
world positions after resizing. A forced doubled-domain test deliberately seeds stale pressure and checks
mean marker speed: approximately 0.728 before and 0.741 after (within 2%, rather than halving). With a
zero-iteration uniform transfer, both are 0.728. Coarsening still changes spatial resolution and fine flow;
world velocities are not intentionally scaled by cell size.

### Startup and staged growth

Profiling found shader preparation, not buffer allocation, dominated the measured cold start. The old
boundary kernel cloned the collider sampling graph for every quadrature point. GPU loops now evaluate
the same face/volume samples without duplicating those graphs. In one local gas-flow comparison:

| Stage | Before compact quadrature | After |
| --- | ---: | ---: |
| Gas preparation | 1,586 ms | 617 ms |
| Gas first populated frame, including preparation | 2,633 ms | 1,316 ms |
| Liquid preparation | 1,585 ms | 1,195 ms |
| Liquid first populated frame, including preparation | 3,517 ms | 2,567 ms |

Gas preparation storage creation accounted for roughly 1.4 ms / 42 MB in the initial measurement;
one boundary compilation awaited about 1,279 ms. Cold pipeline/compiler caches and driver scheduling
vary substantially. The separate small two-system cache fixture prepared in about 361/289 ms with
boundary compilation about 9/5 ms; neither use rebaked the shared field. That fixture disables optional
pressure diagnostics while measuring ordinary preparation. Startup is improved on the measured demo
path but still includes first-use compilation; moving allocations alone would not remove that delay.

`StagedGPUAllocation` keeps current identities valid during geometric growth, prepares replacement
pipelines separately, copies persistent gas state on GPU, swaps at a safe boundary and disposes retired
resources after a queue fence. Boundary changes cancel stale replacements. The 4-to-64-brick fixture
retains density/color, pressure, velocity, wall velocity and transient color exactly. A local run prepared
in about 628 ms while submitting 30 display frames, with zero CPU render-frame hitches above 50 ms;
maximum observed render submission was 0.9 ms, allocation about 0.2 ms and migration submission about
0.3 ms. The measured GPU queue interval around migration was about 1.5 ms (including submission gaps). This tiny fixture does not predict large-domain
hitches; the script records GPU intervals, temporary peak bytes and visible-frame timings separately.

The surface growth test exercises actual demand from 128 to 512 resident bricks. Prediction accounts for
triangles in bricks omitted from the old pool, avoiding an immediate second grow. The final surface has
134,496 triangles and no brick/triangle overflow. One local run prepared in about 228 ms and submitted the
swap frame in 0.5 ms, with about 69.5 MB temporary old-plus-new storage. Initial unexpected overflow and
expert/device ceilings are diagnosed rather than silently dropping data indefinitely.

### Surface topology and volume rendering

The deliberate ambiguous-face test found edge-position arrays could be initialized in a conditional
contour branch and then reused when that branch had not run. Edge positions and gradients are now
materialized before branching. Canonical asymptotic decisions use interior contour hubs, keeping shared
face triangulations consistent. Three saddle/tie fixtures have zero open and non-manifold edges. On the
small worst-case checkerboard field, Classic emits 104 triangles and the decider 264; representative GPU
times were about 0.03 and 0.12 ms respectively. Nonambiguous cells retain the classic fast path. This is
face-ambiguity handling, not full MC33; custom extractor contracts remain unchanged.

All volume texture reads explicitly use LOD zero inside divergent camera/light marches. This removes the
black-hole artifacts reproduced in the earlier fire capture. Fine strata derive directly from their index,
so occupancy jumps preserve the unskipped jitter lattice. Frozen skipped/unskipped masked and unmasked
images agree within one channel byte. Occupancy is conservative final visual density with reconstruction
halos and child transforms, not simulation brick residency. Native WebGPU skips empty regions; WebGL
uses the equivalent full raymarch. The frozen profile isolates density, color, procedural noise and shadow
combinations for both Linear and Cubic, with matched ray sampling and analytic lookup-count bounds.

`dynamicResolution` defaults to true and accepts `{ targetFrameTime, minimumScale }` (16.7 ms and 0.5).
The controller averages GPU timing with hysteresis and slow discrete changes; unsupported timestamp
hardware stays at the fixed `downsample` resolution. Targets are pooled by scale. Along-ray quality and physical segment
opacity stay unchanged. The low-resolution color/transmittance and volume-entry/opaque-depth metadata
are reconstructed in premultiplied form with depth-aware weights. Current opaque depth is rendered before
the volume pass: a nested pass cannot safely read a main-pass copy whose command encoder has not yet
been submitted. This adds an opaque depth prepass at reduced resolution modes, so complex scenes may
benefit less. Full-resolution rendering avoids that extra pass. Shared timestamp ownership is restored
when adaptive rendering is disabled or its last consumer is destroyed.

Native tests match constant-density radiance at full/half screen resolution and cover opaque occlusion,
camera-inside views, orthographic cameras, reversed depth and target reuse. Strong noise can still alias
under insufficient along-ray sampling; this pass does not add temporal accumulation.

Remaining issues concern quality beyond this corrective spec: complex moving-wall/high-speed cases,
coarse-cell/particle clearance through narrow model passages, evolving-plume multigrid stability and
first-use shader compilation. Iterative pressure remains the production default. The bounded Utah-teapot follow-up runs for six simulated seconds with a live reconstructed surface
and no browser errors; it does not establish that every teapot geometry/quality setting produces a resolved small stream.

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
node scripts/tests/preview/fluids/volume-resolution.test.mjs
node scripts/tests/preview/fluids/fluid-collider-bake.mjs
node scripts/tests/preview/fluids/hydrostatic-pressure.mjs
node scripts/tests/preview/fluids/multigrid-topology-transition.mjs
node scripts/tests/preview/fluids/ambiguous-surface.mjs
node scripts/tests/preview/fluids/corrective.test.mjs
node packages/rzmps/tests/simulation/staged-allocation.test.mjs
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
not replace the unresolved topology and long-duration capacity limitations above. The newer native regressions and their scope are described in the current-pass section.

## Design references

- [Obi fluid rendering and realtime Surface Nets](https://obi.virtualmethodstudio.com/manual/7.0/fluidrendering.html)
- [Blender liquid mesh controls](https://docs.blender.org/manual/en/4.5/physics/fluid/type/domain/liquid/mesh.html)
- [Niagara fluids reference](https://dev.epicgames.com/documentation/en-us/unreal-engine/niagara-fluids-reference-in-unreal-engine)
- [Unity volumetric density controls](https://docs.unity3d.com/Packages/com.unity.render-pipelines.high-definition@17.0/manual/Override-Fog.html)

These are design references from earlier investigations, not claims of exact parity or new
comparative measurements in this surface corrective pass.

## Current renderer follow-up

`VolumeRenderer.color` replaces `baseColor`. Independent `minDensity`/`maxDensity` remap all
render density mappings, including Smoothstep, with clamped endpoints. Nullable `colorByDensity`
uses this normalization after density gain; opacity already derives from density, so there is
no separate `opacityByDensity`. Other nullable temperature/speed/vorticity ramps multiply.
Appearance controls are listed directly in the GUI. Fixed sampling algorithms live in
`VolumeSampling.frag`; the WebGL binding generator only emits statically named sources and
contributions. There are no appearance layers: one VolumeLayer is one distinct source, with
an identity parent and transformed children sharing its field bindings.

Mixed collider cells now multiply exported visual density and parameter masses by their fluid
coverage. Specific temperature/speed/curl remain unchanged. This is averaged visual coverage,
not an exact subvoxel collider intersection; conservative solid particle collision is unchanged.
Paused renderer refresh retains the displayed light selection and rejects stale readbacks,
while allowing light appearance edits without advancing the simulation.

The deterministic 480x320 native Chromium child comparison checked 0/1/4/8 children in
Linear/Cubic on WebGL and WebGPU. Transforms matched exactly and images differed by at most
2 byte values. Each source retained one layer and one primary raymarch. Center-ray logical
steps stayed 64; density+color evaluations were 128/256/640/1152, with Cubic using eight
texture reads per evaluation. These are analytical counts for this fixture, not GPU counters.
WebGPU median render times (three samples; milliseconds before -> after) were:

| Children | Linear | Cubic |
| --- | --- | --- |
| 0 | 1.02 -> 2.59 | 5.63 -> 5.52 |
| 1 | 1.60 -> 1.77 | 5.83 -> 5.84 |
| 4 | 3.91 -> 4.38 | 14.59 -> 14.58 |
| 8 | 5.49 -> 5.53 | 26.34 -> 26.43 |

These short measurements do not establish a speedup: the first Linear case regressed, while
Cubic stayed essentially unchanged. Three samples do not distinguish warmup/noise from a
sustained regression. This is a structural simplification, not a performance claim. WebGL GPU timing was unavailable in this harness. Generated WGSL shrank
at eight children (Cubic 71,173 -> 70,290 characters); sampling remains proportional to child
count. Reproduce with `volume-children.mjs <baseline.json> --record`, then rerun without
`--record` after the change; snapshots live outside the repository.

### Physical behavior design boundary (implemented below)

Temperature is already available as heat mass divided by density at each occupied cell;
density is directly available. Nullable ValueByParameter multipliers could drive turbulence,
vorticity confinement and density/heat/color/velocity dissipation without another field or
readback. Apply forces before pressure projection and decay as `exp(-rate * dt)`, keeping
rates nonnegative. Use physical cell density, independent of renderer min/max remapping.
These controls need not be globally constant, but timestep/iteration/grid controls remain global.

Automatic padding must account for the least dissipative and strongest forcing regions across
these curves; using only a nominal rate could truncate long-lived gas. Variable diffusion or
viscosity additionally needs shared-face coefficients to preserve conservative transport.
This renderer-pass design is implemented in the physical-state follow-up below; its fire preset
retains the subsequent user tuning rather than replacing it with the illustrative coefficients.

## Volume quality/startup regression follow-up

The WebGPU demos do not execute the extracted WebGL GLSL binding generator. The frozen real
Volumetric Smoke/Gas Flow fixture reproduced faceted sampling artifacts with the density mask
disabled, so masking and the GLSL file split are not the sole explanation. One jittered sample
per voxel undersamples the steep opacity transition on these thin plumes; four samples produce
a smoother reference. Smoke and steam now explicitly select the two-sample tier and 256 maximum
steps. The library's one-sample standard default and stable full-strength jitter are unchanged.
This reduces aliasing, not a promise of noise-free silhouettes or temporal reconstruction.

Automatic screen-resolution control previously added compute time to render time. Compute-bound
fluid frames could therefore lower volume resolution even when rendering was inexpensive, adding
an unrelated quality loss. The controller now resolves/uses render timestamps only. A regression
feeds 2 ms rendering plus 1,000 ms compute for 192 frames and requires full screen resolution.
Manual downsampling, depth clipping, orthographic/reversed-depth and inside-camera paths remain tested.

The ray-step budget is now a clamped integer uniform, rather than a compiled loop constant and
material invalidation key. Changing steps or samples-per-voxel reuses the pipeline. The frozen-plume
regression checks exact image restoration after quality changes and no new fragment shaders when
moving to the four-sample reference. Source/child binding changes remain structural.

Cold-start measurements found an additional first-visible-draw shader stall of about 240 ms.
Resource preparation previously covered modules only. Renderer.prepareResources is now an optional
non-advancing hook; ParticleSystem.prepare starts renderer preparation alongside module preparation.
VolumeRenderer compiles its actual camera/scene material against existing persistent provider fields.
It allocates occupancy resources but does not dispatch their contents or advance gas/particles during
preparation. Providers without available fields/camera/scene keep ordinary first-use behavior.

Local native Chromium/WebGPU measurements, after imports, on Gas Flow:

| Phase | Smoke before | Smoke after | Fire before | Fire after |
| --- | ---: | ---: | ---: | ---: |
| Preparation | 635 ms | 369 ms | 542 ms | 332 ms |
| First populated draw, including fence | 243 ms | 3 ms | 242 ms | 8 ms |
| Renderer init through first populated frame | 1,168 ms | 666 ms | 1,273 ms | 797 ms |

Compilation/cache/scheduling variation affects these samples. Allocation submission remained around
1–2 ms for roughly 42 MB during gas preparation; it does not explain the first-draw compiler stall.
The ray-budget-uniform change alone only reduced that draw by about 20 ms; overlapping preparation
removed it from the first visible draw. This does not eliminate first-use simulation compilation,
dependency downloads, GUI startup or larger-scene collider preparation. Historical reports are
retained above for comparison, not treated as same-cache controlled benchmarks.

Reproduce with `FLUID_EXAMPLES=volumetricSmoke,volumetricFire node
scripts/tests/preview/fluids/startup-review.mjs /tmp/volume-startup`; add
`RENDER_DURING_PREPARATION=1` to exercise continuing display frames. Use
`volume-quality-regression.mjs /tmp/volume-quality` for frozen full/half-resolution,
mask/jitter/sampling comparisons. Its image comparisons use the same frozen simulation state.

## Physical state modifiers and the tuned fire preset

GasSimulation now supports optional `ByTemperature` and `ByDensity` multipliers on
`turbulenceStrength`, `vorticityStrength`, `noiseFrequency`, `densityDissipation`,
`temperatureDissipation`, `velocityDissipation` and `colorDissipation`. Shared simulation
`temperatureRange`/`densityRange` default to `[0, 1]`. Temperature is specific heat mass/density;
these physical inputs are independent of VolumeRenderer remapping and appearance curves.
Absent modifiers bypass evaluation and preserve the original kernels. Negative results clamp
at zero. Arrays and functions follow the existing ValueByParameter convention, including the
scalar-times-parameter rule; `[1, 1]`, not the scalar `1`, is a constant neutral multiplier.

Active normalization is computed once per cell for the inputs each kernel actually needs.
Forcing uses the current cell state; scalar decay uses the advected/mixed state before decay.
Frequency and strength are evaluated before turbulence noise. Confinement caches are keyed by
scalar ping-pong identity so temperature-dependent force never reads the wrong density buffer.
Compatible curve/range edits update uniforms; adding/removing/changing curve structure rebuilds
cached operators. No simulation field or CPU readback was added. Density/heat/color/velocity
retentions keep exponential rates. Neighbor-coupled diffusion/viscosity, structural settings,
pressure convergence and timestep controls intentionally have no state-driven variants.

Automatic gas padding now combines measured occupied gas with the emitting particle bounds.
The existing maxima readback additionally supplies occupied-cell extents and gas peak speed;
its payload grows from two to nine words, without another readback or simulation field.
Prediction spans `velocityPaddingLookahead` (the fire preset uses 0.5 seconds), rather than
extending peak motion across the entire smoke lifetime. Sampled mean coefficient multipliers
estimate local decay, and gas motion integrates exponential velocity damping. Particle motion
retains a peak-speed guard because gas damping need not apply to emitting particles.

The previous shrink guard used the current coarse domain's cell size, keeping already-large
grids large. It now derives its cell scale from the candidate domain. A controlled four-unit
persistent-gas support case shrinks a 32-unit domain to eight units without excluding gas that
has moved beyond the emitting particles. Actual large plumes can still require larger domains.

The fire factory restores the user's export: rate 50/s, lifetime 1.2 s, scale 0.1, radial speed 1,
density dissipation 0.2, temperature dissipation 4, buoyancy 8, vorticity 10 and turbulence 1.
The previous six behavior curves were removed; only densityDissipationByTemperature `[1, 1.2]`
remains, giving rates 0.2/cool and 0.24/hot. Velocity damping and simulation noise frequency are
back to the user's settings. The initial domain is eight units instead of reserving 32, and
continues adapting to measured support.

Mask bases remain frequency 1, strength 1, contrast 2, speed 0.8 and one octave. Temperature
multipliers belong to VolumeRenderer and reuse already-sampled physical temperature:

| Effective mask parameter | Cool endpoint | Hot endpoint |
| --- | ---: | ---: |
| Strength | 0.25 | 1.5 |
| Contrast | 1 | 2.5 |
| Frequency | 1.25 | 1 |

Smoke therefore has a gentler, slightly finer mask; flames have stronger breakup into tongues.
The color curve is unchanged; opacityByTemperature is `[0.25, 2]` to reduce smoke dominance.
Existing shrinking/fade and transform-noise strength `(0.35, 0.12, 0.35)` remain. One configuration
was checked at two and three seconds: `/tmp/rzmps-fire-rolling-bounds/contact-sheet.png`.

The supplied code export exposed a serializer bug: derived TransformByNoise was caught by the
NoiseModule branch, emitted with an empty key and without the matching import, losing force
strength. Derived behavior is now serialized first. The lost strength cannot be recovered from
that text; the factory's previous strength is retained. Fluid collisionOptions and all new
physical ranges/modifiers now survive export too.

`node scripts/tests/preview/fluids/gas-state-behavior.mjs` checks all seven coefficient products,
nonnegative clamping, inactive shader work, real base/modulated GPU density/heat/color decay,
timestep splitting, and runnable code export preserving TransformByNoise/curves/collider options.
Type tests reject state-driven pressure settings; CPU tests cover physical ranges and conservative
padding rates. Preview: `/tmp/rzmps-fire-state-behavior/contact-sheet.png` (local artifact).


### Dynamic mean and median sampling

`averageDynamicNumber` and `medianDynamicNumber` supplement numeric min/max and use the same
traversal, finite-leaf filtering, cycle protection, uniform function samples, and optional fallback.
Ranges visit endpoints; sets visit members. These estimates do not model probability or joint
state distributions. Median rejects the influence of brief peaks more strongly, so it is useful
for typical-value diagnostics but is not a substitute for conservative support/outlier checks.
The gas predictor uses the mean to avoid treating an entire modifier curve as its worst endpoint;
measured support and short peak-motion guards remain. A regression samples a one-sample speed
spike as mean 25 / median 0 instead of peak 100 at resolution four.

The GPU regression additionally verifies occupied-gas extent reduction and rolling padding,
mask-strength temperature endpoints (including zero-strength bypass), and one Advection Method
GUI control. The duplicate advection selector was removed without changing its code-export hook.

## Published gas presets

The gas examples now live in `examples/presets/volumetricFire.js` and
`examples/presets/volumetricSmoke.js`, with public IDs `volumetricFire` and `volumetricSmoke`.
Their authored guides live under `apps/docs/examples/`. FLIP remains experimental. Steam Burst
was removed; references above describe historical measurements, not current catalog entries.

Fire caps its local domain at eight units, doubles light brightness to four and uses the sprite
fire's heat-distortion subsystem. Smoke now emits a finite pulse: weight is zero so cooling
removes lift without turning it into downward density acceleration. Higher velocity damping,
gentler turbulence and source shrinking/fading keep it a rising puff rather than a ground plume.
Its local domain grows automatically from four up to sixteen units. Three render-only volume
children add density without extra gas solves. See the authored guides for current tuning.

Smoke's falling motion was traced to the inherited FluidSimulation externalForce `(0, -9.81, 0)`,
not only density weight. The promoted smoke preset explicitly sets both particle gravity and
grid external force to zero. The native puff test measured density centroid Y rising from about
0.27 at half a second to 1.13 at 1.5 seconds, then 1.74 as the puff fades. It stayed within an
eight-unit domain in that run (configured cap sixteen). Initial source births use a half-second
rate pulse rather than a zero-time burst, which did not inject on the tested GPU path; that
burst-lifecycle behavior remains a separate investigation. The public smoke preview begins at
half a second so its poster shows the puff rather than the gap between pulses.

The promoted presets also exposed an MSAA-only viewport-depth warmup error on the interactive
canvas: compile-only preparation bound a single-sample placeholder to a multisample depth binding.
VolumeRenderer now defers that warmup when the target is multisampled and depth testing is enabled;
the first actual draw establishes the depth resource. Single-sample/offscreen asynchronous
preparation remains enabled. The real GUI loading test passes for FLIP and both promoted gas
presets. This can leave first-use material work on an antialiased canvas; it avoids invalid bindings.

Heat distortion's opaque-depth pass now hides transparent renderer-owned volumes, rather than
turning their proxy boxes into opaque geometry. VolumeRenderer also skips its normal render-target
work while a scene override material is active. This keeps soft-particle depth capture separate
from volume raymarch/reconstruction passes. A CPU regression verifies the transparent proxy
is hidden/restored while opaque scene geometry remains in the depth pass.

The final concurrent full-resolution preview/GUI rerun timed out after the fire clip completed.
Earlier targeted native smoke-rise/catalog tests, the antialiased GUI loading test, and the
standalone smoke clip passed. The completed fire clip and earlier validated smoke clip remain
available; the smoke preview retains its original camera framing. No further long GPU runs
were made in this preset pass. The renderer depth-pass changes have CPU regression coverage.

## Gas preset regression review

The catalog watcher only changed which factories Vite serves. The preceding preset promotion also
changed emission, domain reservation and rendering work, so it was not behavior-neutral. Smoke's
half-second, pale pulse departed too far from its dark smoke appearance; it now feeds a dark rolling
cloud for 2.5 seconds per five-second loop, retaining zero downward force, buoyancy and render children.
Steam Burst remains removed. Fire reserves the requested eight-unit domain with shrinking disabled
for this preset, avoiding a later shrink/regrowth cycle. The shared grid's default remains unchanged.

The added fire distortion subsystem inherited soft-particle depth capture, rendering the entire
opaque scene again on updates. Its alpha map already feathers its edges; this preset disables that
optional capture while retaining transmission/distortion. General sprite-fire defaults are unchanged.
This removes concrete extra work; it is not a measured claim about all scene frame rates.

The earlier MSAA workaround skipped VolumeRenderer shader preparation on the interactive canvas,
returning compilation to the first visible draw. Preparation now initializes the actual viewport-depth
texture with the target's sample count before asynchronous compilation. A temporary one-pixel target
supplies that sample-count context without rendering a scene or copying depth. The normal visible
draw still copies real scene depth. A naive copy outside the draw failed native validation because
Three reports zero current samples while its intermediate framebuffer is inactive; that approach
was discarded. Native antialiased preparation and subsequent drawing now validate without GPU errors.

A short native fire reproduction retained an eight-unit domain without reproducing the reported
freeze. The updated fixture reached the first populated frame in approximately 0.97 seconds after
module loading; this excludes browser import/GUI startup and is not a controlled before/after speedup.
The focused regression checks smoke rise/fade, fire's cap and disabled depth prepass, and live fire
drawing after antialiased preparation. A longer or scene-specific freeze remains unconfirmed.

### Follow-up: restore smoke and test real fire growth

The fixed-domain change above was not requested and did not diagnose the reported freeze. Fire now
starts at four units, retains its eight-unit cap and again uses normal delayed automatic shrinking.
Smoke's design is restored from the earlier continuous preset: rate 350, sphere radius 0.16, lifetime
0.35, scale 0.28, radial speed 0.2, dark color, original dissipation/turbulence/vorticity/mask settings,
and only GasSimulation plus Collision. The pulse gate, lifetime modifiers and render children added
during the redesign are removed. The narrowly scoped buoyancy change is two to three; particle gravity
is zero, weight is zero and the original horizontal grid force is retained.

Short native runs exercised actual four-to-eight growth in Checkerboard and Gas Flow, rather than
starting at the cap. They completed without GPU validation errors or a reproduced freeze. The Gas Flow
run used interactive pacing for twelve simulated seconds. This does not resolve the user's report;
scene selection and whether the symptom is a stopped field versus a frozen canvas remain relevant.
The focused regression now explicitly requires a four-unit starting domain, subsequent eight-unit
bounds, and continued finite, nonempty, changing gas fields after the transition.

The reported symptom is now narrowed to gas motion stopping in Checkerboard while the camera/UI
remain responsive. A live interactive Checkerboard probe read simulation buffers every second for
sixteen observations: density, heat, velocity energy, field version and renderer noise time continued
changing after reaching eight-unit bounds, with no nonfinite density samples. This still did not
reproduce the stopped volume. The regression additionally reads a central vertical slab of the actual
RGBA16F volume texture after growth, independently of its simulation buffers. Its density sum changed
from approximately 74.51 to 84.46 over the next simulated second; gas centroid Y rose from 1.09 to 1.20,
and RMS speed changed from 1.19 to 1.36. These checks pass on the local native WebGPU run. No solver
or bounds-policy change is justified by that evidence yet; the user's rendering-only symptom remains
unresolved. A recording with the numeric bounds visible would help align the reproduction with the
reported event, including whether the stopped section is the entire plume or retained gas near an edge.

### Grid-owned caps, compact smoke and full-canvas freeze follow-up

The latest report supersedes the earlier symptom classification: the entire fire, distortion and
camera display stop while the profiler remains active, with inconsistent timing. A stalled GPU frame
or device loss is therefore relevant, rather than only a stale gas render texture. The underlying
intermittent event remains unreproduced locally.

Spatial hash radius/nearest queries previously had no structural termination bound when query-quality
limits were disabled. A cyclic chain could execute forever on the GPU. Both traversals now stop after
at most the particle capacity per bucket; a valid chain cannot exceed this, so exact queries remain
exact. No extra storage binding is introduced in gas source gathers. A native regression deliberately
creates a self-linked bucket and verifies radius traversal terminates and nearest lookup returns.
This fixes a demonstrated hang path, but does not establish that corruption caused the reported freeze.

Domain caps now belong to ParticleSpatialGrid options, including CPU-supplied domains, explicit GPU
bounds and GPU automatic expansion. FluidSimulation supplies padded support and applies particle
bounds policy using the grid's cap. Finite power-of-two caps round downward. Managed-grid reuse keys
include the cap, and GUI/serialization place it in Spatial Grid Options. The obsolete top-level fluid
constructor option is removed. Fire retains the user's cap of 16 and automatic shrinking.

Volumetric fire now contains its complete distortion subsystem; it imports no other preset. Smoke
stays continuous at rate 350 with the original explicit gray Color and noise mask. Only cloud-shape
controls change: source radius 0.3, radial speed 0.65, upward velocity 0.8, buoyancy 1.5, density/color
rates 0.8, temperature rate 1.2, and velocity rate 0.6. An origin-centered adaptive domain starts at four
and caps at sixteen. A native two-second preview showed a compact gray cloud; the focused numerical
run used an eight-unit domain and retained upward motion. This is a single visual check, not extensive
parameter searching. CPU and native GPU tests cover cap enforcement and continued fire field/texture
evolution through four-to-sixteen growth.

### Spatial-effect sampling and gas affectors

Current API: `requireSpatialEffects` accepts constructors and exact instances, deduplicated by identity.
`GasAffector(gasCallback, options)` exposes shader-local density, temperature, velocity and color; the
solver converts semantic color/temperature writes back into transported mass. Convenience rate options
remain available. Gas defaults to native GasAffector modifiers plus FluidCollider boundaries; ordinary
particle modifiers are opt-in. `supportForceFields` defaults to false and only edits the ParticleForceField
constructor in the requirements list. Constructor requirements merge with defaults, while subsequent
direct assignment is authoritative. Gas demos explicitly enable force-field support. The renderer still
only consumes fields and has no spatial-effect API. ParticleForceField sampling retains unit reference-air
mass to preserve the prior stability fix; other compatibility samples expose density times cell volume.

Module discovery now retains one Array-compatible SpatialEffectCollection with constructor-identity
buckets. CPU and GPU execution contexts expose that same collection; Boids uses typed BoidAffector
access without changing its steering/range algorithms. Explicit lists, filters, scene traversal and
subclasses still use the existing requireSpatialEffects path. Overlapping requirements do not duplicate
flat entries. CPU delta sampling reuses particles/snapshots; GPU sampling uses local TSL state and the
same automatic-feather helper as ordinary particle updates. Kill stays discrete, and negative color
deltas remain representable.

Gas collects ordinary modifiers and GasAffector through that path. Each applicable permanent effect
uses an independent velocity pass before projection and scalar pass after transport/source injection.
Separate passes avoid pushing the existing solver/source graphs over eight storage bindings. Transient
effects modify a provider-only state; three velocity components fit into unused channels of the two
existing visual scratch planes. Physical fields remain untouched, and repeated render updates do not
accumulate changes. Render speed may reflect transient velocity; vorticity remains physical solver curl.
No per-effect volume is created. Effects operate on active non-solid cells; emitters establish support.

GasAffector adds local density/temperature rates, density retention, acceleration/drag and color
response. These are not solver settings or Particle temperature fields. Constants stay constant inside
a region; curves use full influence at zero and outer feather at one. Empty active cells receive a
neutral color when an affector creates density. Geometry, transforms, filtering and update policy remain
SpatialEffect responsibilities. Dynamic parameter/shape changes invalidate resource-local effect graphs,
including pending staged pool replacements. No default effect class generates cell work when absent.

Focused CPU/type and native WebGPU checks cover constructor lookup, deduplication, explicit discovery,
filters, Boids regression behavior, velocity/color/alpha deltas, feathering, transforms, tags/inversion,
kill, persistent retention, transient non-persistence, runtime heating edits, density sources/retention,
drag and projection order. The library sampling path allocates no GPU storage and does no readback;
readbacks below are test assertions only. The Gas Spatial Effects scene demonstrates an ordinary
permanent feathered wind sphere, a static hard-edged permanent heater, and a moving feathered
Suzanne mesh applying transient density/color changes. It works with the independently selected
particle preset and does not create its own particle system or tracer subsystem.

The focused warm microbenchmark used 512 active cells and 20 velocity-effect updates:

| Effects | Additional dispatches | Fenced elapsed |
| --- | ---: | ---: |
| 0 | 0 | approximately 0 ms |
| 1 | 20 | 1.6 ms |
| 3 | 60 | 2.4 ms |

These are local Chromium/WebGPU samples, not end-to-end frame budgets or statistically stable
scaling claims. Permanent scalar passes and render/export work are excluded to isolate the effect
stage. Reproduce with `node scripts/tests/preview/fluids/gas-affectors.test.mjs`.

### Dev watcher race and return to the initial Gas Volume smoke

The full `npm run dev` entry point reproduced TS2307 errors in dependent workspace declaration
watchers. Each concurrent tsdown watcher was cleaning its shared build directory, deleting declaration
subdirectories and static assets emitted by the preceding complete build. All four package configs now
clean only for one-shot builds. Watch mode preserves the directory while replacing its own JS outputs.
A real watch regression creates declaration/asset sentinels and verifies they survive initial compilation
and a subsequent source edit for rzmps, ammo, jolt and rapier. The corrected full dev command completed
all package builds, reported zero errors in all four declaration watchers, and served demo/docs pages.

Smoke now follows the original pre-fire Gas Volume factory from git rather than another compact-smoke
redesign: rate 300, lifetime 1.2, radial speed 1.5, the original force/noise/size/alpha lifetime modules,
density/color rates 0.9, velocity rate 0.3, buoyancy 1.8, diffusion 0.35, turbulence 2 and vorticity 4.
The source color is uniformly #a59d9d, and no temperature/lifetime RGB ramp changes it. Current two-sample
volume integration, the grid-owned sixteen-unit cap and automatic shrinking remain. The focused native
smoke/fire regression passes, including rising/fading gas, fixed source tint and continued fire updates.

### Reproduced gas freeze: nested downsampling depth pass

The actual Volumetric Smoke/Wind demo reproduced repeated `Cannot destructure property 'object'
of 'renderList[i]'` errors in Three's transparent render loop. GPU completion fences continued to
resolve: this failure was in rendering, not a hung solver dispatch. It becomes possible when adaptive
resolution first reduces the volume's screen resolution, explaining its variable onset and dependence
on scene/render cost. Explicit `downsample = 2` reproduced the same failure without waiting for adaptation.

The volume's onBeforeRender callback rendered opaque depth using the same scene and camera as the
outer draw. Three caches its render lists by those identities; the nested pass cleared the list still
being traversed by the outer transparent pass. VolumeRenderTarget now uses a persistent, separate depth
camera, copying the current projection and world pose without changing the selected camera or scene.
Fixed/adaptive resolution, depth clipping and opacity behavior remain enabled.

The native resolution regression now places additional transparent objects after the volume and renders
successive downsampled frames. Normal/reversed depth, opaque clipping, camera-inside, orthographic and
volume-child checks pass. An isolated actual Wind/smoke demo continued advancing for thirty seconds at
forced half screen resolution, with completed GPU fences and no browser/GPU errors. The replacement
Gas Spatial Effects scene also ran its three regions successfully, including a 64-to-128-brick pool
growth and swap. These checks cover the reproduced rendering failure, not every possible cause of a
future freeze.
