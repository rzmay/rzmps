# Fluid release readiness: correctness and frame pacing

## Demo initialization correction — 2026-11-21

The GUI audit introduced a root-editor delegation error: `buildSystemFolder` called `this.addValue`
for `maxCatchup`, but `ParticleSystemGUI` did not forward that method to `GUIValueEditor`. This threw
during construction before the rest of the editor and initial scene setup could complete. The missing
forwarder is restored. A full demo-page regression now checks system controls, initial code export and
Checkerboard → Wind switching without uncaught errors; isolated collaborator tests did not cover this path.

The user does not reproduce the diagnostic 9-FPS liquid / 17-FPS smoke results in interactive use.
Those measurements are retained as local harness observations, **not validated demo FPS or an established
user-visible regression**. The previous release-blocking interpretation was too strong: fixture pacing
needs reconciliation with the functioning demo before it supports an interactive performance claim.
This initialization fix does not change simulation, rendering quality, time budgets or performance settings.

## Release status — final bounded validation, 2026-11-20

**Correctness:** the retained deterministic migration, hydrostatic/outlet, moving-wall, source/diffusion,
sparse sampling and lifetime regressions below remain the reference evidence; they were not all rerun
in this bounded pass. New normal-RAF liquid/smoke captures report no device loss or runtime GPU/browser
errors. Smoke finishes with nonzero density/color/velocity and no non-finite values in those fields;
all sampled page-demand checkpoints report zero overflow. This does not establish general collider
impermeability or indefinite-session safety.

**Local diagnostic pacing remains unverified against interactive use.** The captures below precede the final local face-builder
compaction; its post-fix gate is the focused analytical regression, not another long RAF run.
The prior accepted liquid baseline is retained below, but a fresh
40-second capture is much slower. A 90-second animated light-probes smoke-room run and a separate
lightweight 90-second control also miss refresh-rate pacing. Do not present the old near-60-FPS liquid
capture or five-second fenced gas result as current sustained performance acceptance. These are new
failed pacing checks, not proof of a specific code regression: there is no matched old/new binary or
controlled host-load A/B. Equally, there is no evidence authorizing dismissal as host noise.

| Capture, native WebGPU, 800×600 | RAF median / p95 | CPU submission median / p95 | GPU union median / p95 |
| --- | ---: | ---: | ---: |
| Prior accepted liquid, 45 s (historical baseline) | 16.7 / 16.7 ms | 3.0 / 3.5 ms | 9.630 / 13.611 ms |
| Fresh liquid, 40 s, foam/spray/tipping retained | 83.3 / 300.0 ms | 46.9 / 105.2 ms | 44.454 / 217.714 ms |
| Smoke room, lightweight control, 30–45 s | 33.4 / 150.0 ms | 34.4 / 124.3 ms | 16.278 / 19.803 ms |
| Same smoke control, 75–90 s | 33.4 / 66.7 ms | 30.1 / 51.5 ms | 19.532 / 30.902 ms |

The fresh liquid executes 1,060 substeps across 364 frames, executing **24.917 of 40.016 requested
seconds** and skipping **15.099 s** under the existing catch-up budget. No budget, quality, pressure,
subdivision or visual setting was reduced. The smoke control executes **83.668 of 91.453 requested
seconds**, skipping **7.785 s** across 1,515 frames and 2,647 substeps. Its RAF measurement lasts about
90 s; requested simulation time can include the first update's prior clock gap. These counts are
explicitly not a new time-discarding optimization.

The control disables stage wrappers and samples GPU timestamps only every thirty frames. CPU/RAF
statistics cover all frames; GPU percentiles describe only those sampled frames. The separate fully
instrumented run records every frame. Stage medians are not additive and neither run fences each RAF.
Vite dependency-optimizer errors before fixture readiness are separated from runtime errors; an
intermediate control interrupted by a development-server reload is excluded. The accepted control
closes file watching, waits for network/fixture readiness, and has zero runtime errors.

**Release interpretation (corrected 2026-11-21):** these local fixture results do not establish a
user-visible performance regression and should not alone be treated as a product release blocker.
Reconcile their pacing with interactive use before asserting representative FPS or a performance sign-off.
The demonstrated demo initialization blocker is addressed above. No new physics/resource-correctness
blocker was established here. Pressure/multigrid, memory, surface reservation, cross-stage address reuse
and further gas tuning remain deferred. The coarse-volume appearance remains accepted and unchanged.

### Extended smoke-room result: no demonstrated late boundary-classification cliff

Both 90-second runs retain the scene's default moving torus knot, all **28 automatically collected
colliders**, live lighting, continuous smoke emission and automatic domain/quality changes. In the
lightweight control, residency grows from eight to **537 sampled pages** at h=0.125 by 20 s, then
coarsens to h=0.25. At 30–90 s, sampled residency is **200–237 pages**, with zero overflow at every
checkpoint. Logical bounds remain rectangular and adaptive; no fixed-domain substitution is used.
At the endpoint, density/color/velocity have **80,894 / 121,341 / 527,448 nonzero components**, all finite.
Nonzero counts confirm retained fields, not conserved physical mass or pixel visibility.

The fully instrumented run's boundary GPU median/p95 per frame is **4.233/5.450 ms** at 30–45 s
and **3.314/4.308 ms** at 75–90 s. For 30–75 s its boundary cost divided by executed substeps has a
**2.260 ms median**; source indexing is **1.798 ms**, pressure solve **1.100 ms** and scalar transport
**0.147 ms** by the same per-substep convention. These labels can overlap and must not be summed.
This does not reproduce the former 49–60 ms expanded-collider classification cliff or unbounded late
page growth. It also does not clear total-frame pacing: CPU submission/catch-up and early large GPU
frames remain real observed failures, and the lighter control does not remove them.

Internal reproduction: `smoke-room-raf.mjs`, default 90 s. Set `SMOKE_STAGES=0 SMOKE_TIMING_STRIDE=30`
for the lightweight control. Artifacts: `/tmp/fluid-release-smoke-room.json`,
`/tmp/fluid-release-smoke-room-control.json`, and `/tmp/fluid-release-liquid/`.
Only the final control is a clean runtime-error acceptance run; the first capture retains startup-only
Vite optimizer errors in its log and is used for stage attribution, not a clean browser-error gate.

### Remaining graph-build attribution — bounded follow-up

The anonymous preparation path is **FLIPSimulation.solveProjection → captureBefore →
FluidPressureProjection.build(before=true)**: construction of the staggered pre-projection velocity
snapshot, not another pressure sweep. The old trace's generic compile stack alone could not identify it.
A bounded replay first isolated the sparse cell-pass wrapper; stable names on boundary, clear and force
programs then left exactly one slow anonymous setup, immediately before the ordinary face build.
Code inspection confirms captureBefore dispatches that program before the later naming helper runs.
In this follow-up it takes **83.4 ms setup / 51.0 ms generation**, with its ordinary face-build sibling
at **95.6 / 45.9 ms**. These inflated local timings must not be equated with the older 29–32 ms range.
The finalization-only attribution replay has a 0.1-second stepping window, not a new FPS acceptance run.

**Local correction:** both face-build variants now receive names at creation
(`rzmps.pressure.buildBeforeFaces` / `buildFaces`). Their three expanded axis expressions become a
fixed three-iteration GPU loop. The donors, wet/dry selection, wall/face rules, component ordering,
precision, output storage and dispatch boundaries remain unchanged. This compacts graph construction;
it does not change pressure solving, iteration counts or multigrid. The analytical transfer/binding
regression passes for constant/linear fields, wet/dry donors, both velocity snapshots, zero-pipeline
compatible capacity growth and baseline storage-binding limits. Build/declaration checks, focused lint,
two trace-accounting tests and local documentation link validation also pass. No post-correction sustained-FPS improvement is claimed:
the two 90-second captures and failed 40-second capture preceded this local change, and another long
acceptance run is intentionally deferred rather than extending this bounded pass.

Clear/force/boundary programs also have stable names at creation so forked prepared owners no longer
depend on live-scene reflection. The named trace separates cheap clear/force setup (**0.8–2.6 ms**)
from boundary classification (**11.2 ms**, fresh variant **9.1 ms** in that prepared generation).
The diagnostic captures creating TSL function text through Three's VarNode wrapper only for slow
anonymous builds. Synchronous setup/analyze/generate time remains distinct from async compilation
wall time. Finalization-only foam/pressure probes and pending compiler retirement occur outside the
measured RAF interval and must not be charged to its last frame. In particular, multi-second pressure
reduction builds found during endpoint diagnostics are not production RAF stalls in these captures.
Artifacts: `/tmp/fluid-release-named-setup/`, `/tmp/fluid-release-final-origins/`,
`/tmp/fluid-release-setup-origins/` and `/tmp/fluid-release-face-regression.log`.

The fresh trace confirms G2P remains the already compact **`rzmps.flip.gridToParticle`** program.
It reaches **236.7 ms setup** in the failed 40-second run, rather than the previous occasional
21–23 ms; multiple unrelated graph families are also inflated. Consequently the old absolute timing
range is historical, not a reliable current bound. There is no evidence here that trilinear donors
became expanded again. A further G2P arithmetic rewrite is deferred; the face-builder compaction above is the only
new graph correction. The report below retains the original compact-donor/stencil/divergence
A/B as historical mechanism evidence, not fresh performance acceptance.

## Volume appearance versus simulation quality

The renderer still defaults to linear/trilinear reconstruction at explicit LOD zero. Density is integrated
with distance-corrected opacity; it is not interpreted as cell mass. Density-noise coordinates remain in
simulation space, and the screen-space jitter seed is independent of voxel coordinates. The source/diffusion
scale corrections did not change those rendering equations.

A fixed self-lit Gaussian cloud, constant flow velocity, density masking and enabled jitter isolates sampling
from simulation changes. The native WebGPU comparison records:

| Case | Cell width | Samples/voxel | Max steps | Central-ray spacing | Grain metric |
| --- | ---: | ---: | ---: | ---: | ---: |
| Reference | 0.125 | 2 | 256 | 0.0625 | 1.065 |
| Coarser field | 0.25 | 2 | 256 | 0.1250 | 1.358 |
| Coarser, matched world spacing | 0.25 | 4 | 256 | 0.0625 | 1.076 |
| Padded depth, same cell width | 0.125 | 2 | 256 | 0.0934 | 1.105 |
| Padded depth, larger step budget | 0.125 | 2 | 512 | 0.0625 | 1.068 |

Grain is mean absolute four-neighbor image Laplacian over visible cloud pixels, not a GPU timing or universal
visual-quality score. Doubling cell width increased this metric by about **27%** in the controlled fixture;
restoring world-space sample spacing brought it close to the reference. Padding can enlarge the ray interval
enough to hit the step budget even when physical cell width stays unchanged. The fixed world-point mask value
agrees within **3e-7** across layouts, repeated images are identical, and mean brightness changes by less than
one percent. Existing WebGL/WebGPU opacity/scene-depth tests also pass.

This establishes a real sampling sensitivity, not proof that every perceived live-smoke difference comes from
the renderer. The fuller source, slower density decay and higher turbulence frequency also changed the physical
plume. Removing the old cell-size-dependent diffusion also removes unintended extra smoothing at coarser tiers;
that can expose more density structure even with unchanged renderer controls. No mask/jitter removal, automatic sampling increase, default-quality change or simulation smoothing was
introduced by this audit. `samplesPerVoxel: 4` and a larger step budget are available tradeoffs when a coarser or
larger domain needs finer render-only detail.

The regression is `volume-scale-sampling.browser.test.mjs`; local images and metrics are saved under
`/tmp/rzmps-volume-scale-*` and `/tmp/rzmps-volume-scale-sampling.json`.

## Animated light-probes room: collider classification bottleneck

The room animates a torus knot by default. Any moving collider invalidates the combined boundary cache,
so the old graph resampled **all 28 colliders** over every active gas cell. The local geometry bakes and
atlas copies are reused under rigid motion; repeated BVH baking was not the expensive per-frame stage.
Boundary classification uses **21 samples per collider/cell**: one center, twelve face-quadrature points,
and eight fluid-volume points. This quadrature existed before the atlas work.

**Reproduction before correction:** native Chromium/WebGPU, 800×600, five timed samples after two warm-up
frames at each checkpoint. At five simulated seconds, cell width remained **0.125**, active pages
reached **453** (231,936 active cells), and resident capacity was 1,024 pages. Median GPU time was **80.74 ms**,
fenced wall time **107.4 ms**, and CPU submission **6.2 ms**. Boundary classification alone took **60.43 ms**.
The one-/three-second checkpoints had 128/301 active pages and **1.32/32.04 ms** boundary updates. This
reproduces the reported sub-10-FPS slowdown without a quality decrease.

**Correction:** compatible large collider sets use a compact GPU loop over a shared parameter buffer,
rather than expanding one complete collider graph per mesh at every quadrature site. The atlas remains one
sampled texture binding. Inverse/motion matrices, local bounds, resolution and atlas offsets are uploaded as
small records; ordering, last-hit wall velocity, fractional faces and conservative solid classification remain
unchanged. Direct sampling is retained for small/shared-field sets that do not require an atlas. Query coordinates are captured before entering the collider loop so nested quadrature iterators
cannot change the sampled point. Uniform power-of-two bake resolutions use this path. Mixed or non-power-of-two
resolutions and custom conditions retain individual sampling, preserving exact zero/nonzero occupancy decisions.

A bounds-check-only experiment did not materially improve matched-state performance and was not retained as
the standalone fix. The large expanded graph is the demonstrated performance cliff; exact driver-level register
spilling versus instruction/cache behavior has not been measured.

**Same-state comparison, 414 active pages / 211,968 active cells, cell width 0.125:** the previous expanded
atlas graph takes **49.19 ms** GPU; the compact loop takes **1.90 ms**, about **26× faster**. Maximum boundary-field
error is **zero**. On an identical eight-collider subset, direct textures take **0.52 ms** and atlas sampling
**0.54 ms**: packing itself is not the large regression. The full old direct-texture graph requires eighteen
sampled textures/samplers and cannot execute under baseline sixteen-binding limits; no invalid full-room
reference timings are used.

| GPU scope at five seconds | Before, 453 active pages | Compact loop, 414 active pages |
| --- | ---: | ---: |
| Boundary classification | 60.43 ms | 1.90 ms |
| Pressure topology | 0.22 ms | 0.20 ms |
| Pressure sweeps | 1.96 ms | 1.01 ms |
| Pressure solve/control scope | 1.47 ms | 1.03 ms |
| Velocity advection/forces | 0.26 ms | 0.23 ms |
| Scalar advection/diffusion/decay | 0.21 ms | 0.13 ms |
| Volume export | 0.25 ms | 0.15 ms |
| Renderer occupancy | 0.93 ms | 0.71 ms |
| Lighting compute union | 0.80 ms | 0.24 ms |
| Scene render scope, including volume | 4.98 ms | 4.44 ms |
| Total frame GPU interval union | 80.74 ms | 9.90 ms |
| CPU submission | 6.20 ms | 4.10 ms |
| Fenced wall time, including measurement readback | 107.40 ms | 30.00 ms |

These are separate per-scope medians, not additive totals. Some engine compute intervals overlap span labels;
the isolated boundary probes establish attribution independently. Evolving before/after runs have different
page counts because asynchronous preparation/admission changes wall-clock opportunities; use the frozen
same-state result for the strict algorithm comparison. Fenced wall time includes diagnostic mapping/queue
completion and is **not a measured unfenced RAF FPS**. Remaining work includes CPU/queue frame pacing, source
spatial-index submission, pressure, occupancy reduction and rendering as the plume grows. The GPU fix does not
establish a sustained 60-FPS guarantee on all devices.

Validation includes the animated room's retained smoke and visible pixels, exact compact/reference quadrature,
and twenty-collider shared-geometry/mixed-resolution fixtures preserving both binary solids and fractional
boundaries exactly.
`apps/demo/benchmarks/fluids/diagnostics/smoke-colliders.mjs` is the focused internal runner; per-pass traces stay
in its JSON output. The accepted local capture is `/tmp/rzmps-smoke-colliders-accepted.json`.

## Collider texture limits

Boundary classification packs large sets of geometry-backed occupancy fields into one sampled 3D atlas.
Sets of at most eight distinct fields retain direct sampling. Atlas copies run only when the field set
changes; collider transforms and simulation quality changes reuse local-space occupancy data. Sampling
keeps each field's trilinear reconstruction and out-of-range/inverted behavior.

The GPU regression uses twenty distinct fields at mixed bake resolutions on a device limited to sixteen
sampled textures per shader stage. Atlas/direct sample error is **zero**; boundary values remain finite,
unchanged sets reuse the atlas, and removing the large collider set releases it. The actual volumetric-smoke
light-probes-room fixture discovers **28 colliders**, uses the atlas and completes preparation plus sixty
rendered simulation frames without GPU validation errors. No higher device limit is requested.

The room's closed `BackSide` box previously classified its entire interior as solid: a twenty-frame
smoke reproduction retained **zero mass** despite finite buffers and valid shaders. Automatic collection
now inverts closed, exclusively back-sided receivers. Open sheets and front/double-sided solids retain
their existing occupancy. Material-side changes invalidate the cached classification. With this correction,
the room retains **1.62 mass units** after one simulated second; a rendered volume-on/off comparison finds
**21,340 pixels** differing by more than two color levels. The regression now checks retained smoke and
actual visibility as well as GPU validity.

Smoke's fuller source and slower dissipation expose more of the existing motion; turbulence coefficients
were not changed by the atlas work. The preset now uses turbulence strength **1.5** and frequency **1.5**.
Vorticity confinement remains explicitly proportional to cell width, so coarsening can still change its
visual strength; no vorticity solver change is part of this correction.


## Retained correctness evidence and historical spike investigation

### Liquid: the second-tip burst came from the scene's floor-clearance trajectory

The reported burst reproduces at fixed 1/60-second updates and stable cell width **0.125** throughout
the second tip. Around 30.27–30.52 s, roughly **430–451 particles** rise faster than two world units/s;
maximum upward speed reaches **2.98**, while pressure residual stays below **0.27** in that interval.
There is no coincident quality change or non-finite state. Removing swept-wall correction only for
the second tip still produces **370** fast-rising particles, so that correction is not the main cause.

The scene prevented floor intersections using the corners of the teapot's entire bounding box.
This includes a fictitious bottom corner under the elevated spout. Keeping that empty corner above
the floor raises the pivot from **0.520 to 2.135** world units at 45°, unnecessarily hoisting the
container and its full liquid load. Correct floor support needs a pivot height of only about **1.15**.
The grid responds to the imposed wall motion; the bad trajectory becomes especially obvious when
the vessel is nearly full on its second cycle.

**Corrected:** cache the actual mesh's projected XY convex hull once, and evaluate its support under
Z rotation. This preserves the existing angular easing, angular speed limit, period, angle and floor
clearance, without scanning thousands of vertices each frame. Neither solver strength nor fluid
velocity was reduced. The isolated second-tip support correction reduces the fast-upward count
from **451 to one**; the actual preset with the correction active for both tips also peaks at **one**,
with maximum upward speed **2.03**. Remaining small waves/splashes are not clamped away.

The tipping/pouring browser regression passes, including collider alignment, spout flow, spray,
finite particles, angular speed limits, fixed emitter position and **precise mesh minimum Y = -0.43**.
The floor test now uses precise vertex bounds: a transformed bounding box cannot validate the very
empty-corner problem being corrected. The internal second-tip gate checks the fraction of fast-rising
markers; `FLIP_TIP_ASSERT=1` enables it for future diagnostic runs. No physics/quality API changed.

### Rare spikes: staged surface-kernel compilation, then catch-up work

All eight GPU spikes in the preceding accepted RAF capture executed **two substeps**. Seven have
nearby graph setup/generation work; one has no individually measured build slice above 8 ms in the
searched window and is not attributed conclusively. Pressure is about **1.3–3.7 ms per substep**;
the expensive frame is multiple ordinary updates, not a 20-ms intrinsic pressure solve.

Previously anonymous 30-ms programs are now identified. Prepared reconstructions are not live
renderer owners yet, so reflection over the current surface missed them. Their programs are named
before compilation. The bounded two-second reproduction identifies **`rzmps.surface.kernelNode.0`**
setup at **32.0–32.7 ms**: the particle-support/covariance/anisotropy kernel built for a staged liquid
surface. Its cache depends on the reconstruction query-grid resource version and anisotropy mode.
Preparing replacement reconstructions can therefore rebuild this graph even while the live fluid
quality is stable. Smaller pressure build/project slices of about 15–19 ms also delay updates.

This explains the recurring scheduling/catch-up spikes; it is separate from the scene-motion burst.
No memory/device failure or persistent viewport freeze was observed in these captures. The appropriate
next performance correction is to reuse the surface support-kernel program across compatible query-grid
backing changes, or make that graph construction smaller. Reducing particles, quality, pressure sweeps
or catch-up limits would conceal rather than correct this preparation dependency.

The corrected scene's final 45-second RAF run: GPU median/p95/p99 **10.06/13.82/15.32 ms**,
CPU submission p95/p99 **3.8/4.9 ms**, RAF p99 **16.8 ms**. Fourteen of 2,678 GPU frames exceed
16.67 ms (maximum **23.16 ms**); maximum substeps **three**, skipped time **zero**, long tasks ≥50 ms
**zero**, GPU/browser errors **zero**. The occasional three-step case means the earlier claim that
all three-step bursts were gone was specific to that earlier capture, not a general guarantee.
The revised physical trajectory retains a different liquid workload, so this is not a matched
throughput comparison against the old scene. Artifacts: `/tmp/teapot-floor-raf`,
`/tmp/teapot-spike-named`, `/tmp/teapot-spike-owner`, `/tmp/teapot-spike-origins`.

### Gas corrective pass — completed and regression-tested

**Source normalization:** the physical radius is half the largest absolute particle scale (a tiny
numerical floor handles point-sized sources). A separable tent is integrated analytically over each
voxel; its three integrated axis weights are multiplied and divided by `h³`. These fractions partition
unity across grid phases, including when a particle is smaller than one voxel. Each particle emits
`mass * alpha * sourceStrength * dt` physical mass. Scalar, temperature-mass, color, velocity relaxation
and transient render-source gathers share the same kernel and conservative query extent. Particle
size controls support rather than total mass. No normalization pass or additional buffer is required.
Blocked/out-of-domain deposits are still discarded, not redistributed around colliders.

**Physical diffusion:** `scalarDiffusion` now means **world units²/second**. Its six-neighbor mixing
fraction is `6D*dt/h²`, clamped for positivity. Base diffusivity also requests `dt <= h²/(6D)`, even with
velocity adaptive stepping off. Very high diffusivity remains subject to the ordinary substep/time
budgets. Custom GasModule increases must respect this bound; shader-local coefficients cannot
request CPU-side substeps. Diffusion reads a completed advection snapshot instead of mixing an
advected center with unadvected neighbors. This uses the existing ping-pong fields with an additional
rules/stencil dispatch, without allocating new field storage. Coefficient toggles rebuild the appropriate
transport path. Existing concentration-preserving quality migration is unchanged.

Smoke/fire coefficients are converted at the original **h=0.125** reference: legacy neighbor mixing
rate becomes `D=rate*h²/6`; source/velocity strengths are calibrated with the reference cone volume
`π*h³/3`. This preserves reference-scale tuning approximately, not pixel-identical source footprints;
the normalized footprint is separable rather than radial. No subdivision, wind, maximum bounds,
pressure iteration or time-budget setting was reduced to conceal the growth.

| Corrected GPU check | Result |
| --- | --- |
| Same particle, h=0.125 and 0.25, sourceStrength=1, dt=1/60 | Mass 0.0166666694 and 0.0166666722; coarse/fine **1.00000017** |
| Off-center sources, h=0.0625/0.125/0.25/0.5, scale=0/0.1/0.9 | Mass **0.0133333343–0.0133333346**, expected 0.0133333333 |
| Same sources, specific temperature=3, RGB=(0.2,0.4,0.8) | Heat **0.040000003**, color mass **(0.002666667,0.005333334,0.010666667)** |
| Continuing source through h=0.125→0.25→0.125 | Mass **0.016666668→0.033333334→0.050000002** |
| Gaussian diffusion at D=0.00208333, one second, h=0.125/0.25 | Variance growth **0.01249135/0.01233264**, ratio **0.98729**; ideal 6Dt=0.0125 |
| High D=0.1, h=0.0625, velocity CFL disabled | **45 substeps** for 15 frames; requested/executed **0.25/0.25 s**, skipped **0** |
| Same high-D fixture | Variance growth **0.14992686**, ideal **0.15**; mass retained **99.9981%** |
| Source-free quality transfer | Mass retained **99.99746%**; unchanged migration implementation |

The coarse diffusion fixture's absorbing edge explains its small variance/mass deficit; this is not
bit-identical discretization. Semi-Lagrangian numerical diffusion, cell-center moment quantization
and the existing cell-width-scaled vorticity confinement can still affect appearance across quality.
These were not rewritten as part of this bounded correction.

**Actual smoke-on-wind:** the corrected 15-second run has mass **3.26** at 3.017 s and **1.67** at
7.017 s (previously 110.74 and 2096.23). At 14.017 s it is **1.67**, with logical bounds **36×24×16**
(previously about 88×72×80). Wind remains (36,12,0), drag 0.6 and emission 100/s. All three observed
coarsening/refinement remaps preserve mass to better than **1e-7 relative**. The loop restarts emitter
time after ten seconds; transition timestamps in raw traces use loop-relative system time. This
confirms removal of the demonstrated source/spread feedback, not universal invariance of plume shape
or a new steady-state FPS claim. The diagnostic is fixed-step, with fenced GPU work and periodic renders.

`gas-quality-physics.browser.test.mjs` promotes the bounded physical fixture to a normal GPU
regression. The internal runner retains detailed moments; `GAS_QUALITY_ASSERT=1` enforces all seven
gates. Source-mask tests separately cover both advection methods, transient attributes and source
death; GasModule tests cover fused snapshot semantics. Shared metric tests verify physical-volume
weighting and nonresident exclusion. No browser/GPU errors occurred in the corrected physical or
wind runs. Artifacts: `/tmp/gas-quality-physics-corrected.json`, `/tmp/gas-quality-wind-corrected.json`;
pre-fix references: `/tmp/gas-quality-final-diagnostic.json`, `/tmp/gas-quality-wind-before.json`.

## Previous accepted preparation correction and liquid baseline

**Historical baseline:** the corrections remain in the implementation, but the timing acceptance below
predates the failed 2026-11-20 controls at the top. "Final" in this section refers to that earlier pass.

The startup-tier/storage-only growth changes below are retained. This follow-up targets the remaining
compiler stalls rather than changing quality, pressure work or time budgets.

### Corrections and measured graph-build CPU

G2P repeatedly expanded eight trilinear donors for each staggered component and each before/after
field. Pressure topology similarly expanded six neighbor classifiers, and divergence repeated the
three directional flux expressions. These are now small fixed-count **GPU loops**, retaining the
same donors, coefficients, sparse addressing, wet/dry normalization, precision and pass boundaries.
Stencil traversal remains axis-major, negative then positive. Divergence accumulates positive flux
then subtracts negative flux in the original axis order. Pressure sweeps remain fixed at 28 in the demo.

Synchronous setup/analyze/generate CPU is now traced through Three's builder diagnostic hook. This
excludes asynchronous yields and driver waits, restores all wrapped methods after build completion,
and preserves existing diagnostic callbacks. Named families and build-stage totals also appear in the
public benchmark counters. Deep per-build records are saved separately as `graph-builds.json`.
Compilation concurrency remains bounded at four; compiler cancellation and queued-GPU ownership
rules are unchanged. No additional per-frame GPU pass or neighborhood data structure was introduced.

| G2P build component | Expanded donors | Compact donors |
| --- | ---: | ---: |
| Setup, ms | 150.2–153.1 | 18.4–20.4 |
| Shader generation, ms | 94.8–97.0 | 11.3–11.5 |
| Analyze, ms | about 23 | about 3 |
| Eight-second fixed replay GPU median / p95 / p99, ms | 6.051 / 6.509 / 6.654 | 5.853 / 6.282 / 6.370 |

That first controlled comparison identified the remaining stencil setup at 50–57 ms and divergence
setup at 26–30 ms. The final version compacts those graphs too. No interpolation quality was reduced.
Artifacts for the isolated donor correction: `/tmp/flip-build-before` and `/tmp/flip-build-after`.

### Fine-tier pressure comparison and baseline binding limit

The nine-storage-binding failure is corrected. Multigrid residual construction now reuses the
already-classified pressure-stencil active flag rather than binding marker density and boundary
classification again. The coarse adapter uses that same active flag and physical face openness.
Coarse geometry must retain openness even at dry neighboring cells, whose inactive pressure rows
have zero cached coefficients. This avoids a redundant binding and prevents a dry row from being
mistaken for a closed physical face. The diagnostic reports **zero programs exceeding eight storage
bindings** without requesting higher device limits.

On a frozen real teapot state, cell width 0.03125 and 256 slots, each row restores identical input
pressure before seven timestamped solves. Compilation is excluded. Cold and warm starts are separate.

| Pressure method / work budget | Warm GPU median, ms | Warm residual | Cold GPU median, ms | Cold residual |
| --- | ---: | ---: | ---: | ---: |
| Iterative / 28 | 2.532 | 0.00002289 | 2.527 | 0.02361 |
| Multigrid / 28 | 5.853 | 0.0001431 | 5.841 | 2.031 |
| Multigrid / 56 | 10.321 | 0.00003815 | 10.358 | 0.4615 |

**No multigrid promotion is justified by this liquid workload.** It fails the equal-residual target
while costing more; reporting fewer fine sweeps as a speedup would be misleading. Warm pressure is
retained across compatible growth. The configured tolerance is still zero, so there is no existing
positive target authorizing fewer production sweeps. All variants have zero non-finite samples.
Warm maximum projected physical divergence remains approximately 3 because this fixture includes
nonzero marker-density restoration. The cold 56-budget MG case reaches 3.416; this is additional
reason not to use it as the liquid default. Fine pressure remains an independently measured future
target; cross-stage particle/cell-address reuse should precede ordinary arithmetic micro-optimization.
Raw matched-state results: `/tmp/flip-pressure-compatible/pressure.json`.

### Correctness coverage

All five focused browser suites pass: exact same-tier capacity migration, moving static/translating/
rotating/accelerating walls, hydrostatic/outlet pressure, source-free 2× coarsening/refinement, and gas
pressure/boundary/resource lifecycle. The baseline-storage fixture additionally checks analytical
constant and linear face fields, before/after velocity, brick seams, and wet/dry donor normalization,
then executes FLIP multigrid under the default eight-binding limit. No tolerance was relaxed.
Unit coverage verifies synchronous-build accounting, no nested double counting, diagnostic-hook
restoration, compiler cancellation, storage lifetime, capacity limits and startup policy.

### Final fixed replay and real-RAF acceptance

The final fixed replay runs 2,700 updates at 1/60 second through 45 simulated seconds. Foam, spray,
automatic tipping, rendering resolution and all quality/time controls remain enabled and unchanged.
The real-RAF run follows separately with no per-frame fence. These are the same preset/event controls,
not bit-identical trajectories: asynchronous tier adoption and timestep scheduling differ. The isolated
sampling tests above establish numerical correctness independently of the performance comparison.

| Measurement | Prior 45 s RAF checkpoint | Final fixed replay | Final 45 s RAF |
| --- | ---: | ---: | ---: |
| GPU median / p95 / p99, ms | 9.314 / 14.840 / 56.379 | 9.247 / 13.560 / 14.246 | 9.630 / 13.611 / 14.564 |
| CPU submission median / p95 / p99, ms | 3.2 / 3.9 / 10.6 | 2.9 / 3.6 / 4.1 | 3.0 / 3.5 / 4.4 |
| GPU frames >16.67 ms | 78 / 2358 | 0 / 2700 | 8 / 2687 |
| GPU maximum, ms | 152.134 | 15.433 | 26.007 |
| RAF p95 / p99, ms | 16.8 / 133.3 | not RAF | 16.7 / 16.8 |
| RAF maximum, ms | 283.3 | not RAF | 33.4 |
| Updates executing multiple substeps | 85 | 0 | 22 |
| Maximum substeps per update | 4 | 1 | 2 |
| Skipped simulation time, seconds | 1.726 | 0 | 0 |
| Recorded long tasks ≥50 ms | 27 | 0 | 0 |

The fixed replay's fenced loop intervals are 15.7 ms p95 / 34.4 ms p99, with a maximum 89.2 ms;
these include background preparation and queue waits, and must not be reported as RAF intervals.
Final real-RAF pressure median / p95 / p99 is **1.655 / 2.274 / 2.767 ms**. Typical pressure cost is
within budget without changing its 28 sweeps. The final trace measures stencil setup **10.6–12.6 ms**
and generation **3.2–3.4 ms**, down from 50–57 ms setup. Divergence setup is **11.6–12.6 ms**,
down from 26–30 ms. Remaining occasional unnamed setup slices reach about 29–32 ms; G2P setup can
still reach 21–23 ms. These can miss a refresh, but do not produce the former multi-frame blocking
and 3–4-substep feedback loop in the measured interval.

Compiler preparation begins inside the existing one-second quality hysteresis window. The final
RAF's initially requested finer candidate prepared in **875.9 ms** and was not adopted after the
observed workload changed. The later coarser candidate prepared in **890.9 ms**, then adopted
**100.1 ms** after readiness at 13.662 s. This is readiness plus unchanged policy timing, not another
compiler hitch. Exactly one tier was adopted, 0.0625 → 0.125; adaptation remains free to change later.
Started/ready timestamps and durations are exposed separately; a new request clears stale readiness
metrics so timestamps from different candidates cannot be paired accidentally.

Both final runs report zero denied pages, non-finite samples, clipped surface particles, triangle
or brick overflow, browser errors and GPU errors. Final real-RAF context: **10,497 liquid markers**,
241 spray markers, 255 foam markers / 543 foam children; peak reported simulation residency 62 pages
of 4096 cells, capacity up to 128, 32,512 reconstructed triangles. Reconstruction remains at its
configured quality. Its 763 surface bricks are a separate grid from the simulation pressure pool.
Maximum post-projection divergence at the final evolving checkpoint is 3.027 (the density-relaxation
target is nonzero), mean 0.392 and residual 0.07537. These are not substituted for the source-free,
hydrostatic and moving-wall regression tolerances.

The idle RAF baseline is 16.7 ms median/p95/p99. Chrome's 0.1 ms timestamp quantization means the
literal `>16.67` RAF counter includes ordinary 16.7 ms refreshes. The unmodified counters remain
available; actual delayed-frame context is **14 RAF intervals >20 ms**, five >33.33 ms and a 33.4 ms
maximum. No universal every-frame 60-FPS guarantee is claimed. The milestone's measured goal—remove
avoidable startup/capacity compilation and substantially reduce compiler-induced catch-up/tail
latency without discarding time or reducing quality—is met on this representative workload.

A first final RAF attempt completed stepping/teardown but timed out returning its monolithic deep
DevTools result; it is excluded from acceptance statistics. The browser remained responsive and its
simulation clock reached 45.007 s. Per-frame compiler records previously duplicated all cumulative
family counters (the fixed replay alone produced 82 MB of frame JSON). The runner now returns compact
metadata, transfers frames in batches of 120, and keeps full build stages in their separate file.
Per-frame records still preserve active compiler families, current capacity/quality preparation,
requested/executed/skipped time and per-substep GPU costs. Chunked final export completed normally.
This was a diagnostic finalization issue, not evidence of a viewport/device freeze.

Artifacts: `/tmp/flip-final-replay`, `/tmp/flip-final-raf-chunked`,
`/tmp/flip-final-correctness.log` and `/tmp/flip-final-baseline-storage.log`.
The five GPU suites, ten focused units, package/declaration build, TypeScript and focused lint pass.
No general sparse-domain/admission algorithm was redesigned. Future work should address the remaining
occasional setup slices or reuse particle/cell addressing across P2G, separation and surface support
only if another measured workload requires more throughput. Multigrid remains unpromoted until a
liquid workload demonstrates equal-accuracy benefit.

## Historical — startup tier and storage-only capacity

At this preceding checkpoint, startup and compatible resident growth were corrected. The full
frame-pacing milestone was **not yet closed**: quality-specific graph compilation and later spill/catch-up tails remain. No pressure sweep,
catch-up/substep limit, particle lifetime, reconstruction resolution or adaptive quality limit was reduced.

### Initial tier and deterministic startup replay

Preparation now selects a normal adaptive tier before particles are populated. Finite configured
maximum extent is the first coverage estimate; otherwise emitter support and non-thin collider extent
provide evidence. Unknown support keeps the configured minimum. The estimate uses one geometric tier
finer than predicted coverage, clamped to the existing min/max policy. It only seeds the empty grid;
subsequent refinement/coarsening, hysteresis and automatic bounds remain enabled as configured.
For the teapot's maximum extent 10, reference side 8 gives initial cell width 0.0625 rather than
0.015625. Subdivisions remain 3+4. Static-quality and already-populated systems are not reseeded.

Two fixed 480-frame, 1/60-second replays use the current full teapot, foam and automatic tipping.
GPU columns are timestamp interval unions; CPU is submission time. Fenced loop intervals are **not RAF**.

| First eight simulated seconds | Finest-first | Predicted startup |
| --- | ---: | ---: |
| GPU median / p95 / p99, ms | 6.073 / 16.077 / 38.778 | 6.131 / 6.720 / 6.939 |
| Pressure median / p95 / p99, ms | 1.705 / 4.893 / 16.178 | 1.548 / 1.946 / 2.083 |
| CPU median / p95 / p99, ms | 2.8 / 6.6 / 8.6 | 2.9 / 3.7 / 4.9 |
| Fenced loop interval p95 / p99, ms | 49.9 / 155.9 | 14.9 / 84.5 |
| GPU frames >16.67 ms | 23 / 480 | 0 / 480 |
| Initial → final cell width | 0.015625 → 0.0625 | 0.0625 → 0.0625 |
| Adopted quality changes | 1, frame 59 | 0; final startup tier present immediately |
| Peak reported resident pages / resident backing capacity | 165 / 512 | 55 / 128 |
| Peak resident cells, pages × 4096 | 675,840 | 225,280 |
| Final cumulative pipeline creations | 313 | 273 |
| Maximum executed substeps per update | 3 | 1 |

The before replay adopted its eventual tier after 2.671 seconds of measured wall time (approximately
one simulated second). These are deterministic timesteps/events, not bit-identical particle trajectories:
changing initial quality intentionally changes early numerical evolution. Resident telemetry is asynchronous;
the maximum of each counter is reported independently. Final mean projected divergence is 0.2984 before
and 0.2891 after, maximum approximately 3 in both (the marker-density correction target), with zero
non-finite samples. Both surfaces report zero clipped particles and zero triangle/brick overflow.
The three-step finest-start workload also includes cell-width/CFL demand; it must not all be attributed
to compiler-induced catch-up. Internal artifacts: `/tmp/flip-startup-before` and `/tmp/flip-startup-after`.

### Program-invariant resident growth

FLIP now follows the existing storage-only sparse/pressure capacity path: allocate backing in short
slices, copy retained state, retarget storage nodes/uniforms, then adopt behind the staged fences.
The live grid, projection, transfer programs and pressure warm start keep identity. Candidates never
retarget live storage during preparation, and old resources remain owned through queued use.

- **Runtime state:** resident capacity, directory/backing dimensions, buffer identity, physical field
  extent, packed second-plane offset, face/stencil capacity and dispatch sizes. The packed FLIP
  before-velocity plane now uses the runtime field-stride uniform, including in already-compiled shaders.
- **Structural state:** brick/cell layout and interpolation algorithm, particle-buffer schema,
  collider representation, solver algorithm and reduction hierarchy depth. Reduction hierarchy shape
  is reserved once for the device-reachable capacity; its actual processing remains compact/indirect.
  Quality replacement still creates distinct graphs; it is not claimed to be storage-only.

Forced **128 → 256** resident growth: **zero new pipelines**, identical program/grid/projection objects,
exact retained pressure, velocity, before-velocity and boundary planes, and zero new tails/sentinels.
An old compiled accessor correctly reads the relocated before-velocity plane after adoption.
Preparation wall time is **3.2 ms**, allocation **0.4 ms**, storage preparation **0.1 ms**, graph construction
and compilation **0 ms**, migration submission **0.3 ms**, binding/swap **0.2 ms**, adoption CPU **0.5 ms**,
and the measured adoption/fence envelope **12.5 ms**. Components are overlapping instrument scopes,
not additive. The historical liquid capacity lifecycle took roughly four seconds; its different
512→1023 workload is context, not a matched speedup ratio. New exact fixture:
`apps/demo/tests/fluids/flip-capacity.browser.test.mjs`; raw log `/tmp/flip-capacity-test-3.log`. The final rerun independently confirms zero pipelines and exact
fields, with preparation **1.0 ms**, adoption CPU **0.5 ms** and fenced envelope **13.7 ms**
(`/tmp/flip-capacity-final.log`); these small allocations vary with driver/cache state.

### Full real-RAF reliability and remaining build stalls

The final 45-second full teapot run includes foam, steady accumulation, tipping, spills and three quality
adoptions. No per-frame fence is inserted. Resolution is 800×600. GPU/browser errors: zero.

| Full interactive workload | Previous retained run | Current run |
| --- | ---: | ---: |
| GPU median / p95 / p99, ms | 8.66 / 55.10 / 79.75 | 9.31 / 14.84 / 56.38 |
| CPU median / p95 / p99, ms | 3.3 / 7.6 / 32.4 | 3.2 / 3.9 / 10.6 |
| RAF p95 / p99, ms | 66.7 / 133.3 | 16.8 / 133.3 |

The earlier run is retained contextual evidence, not an alternating paired statistical comparison.
Current GPU frames above 16.67 ms: 78/2358; four-step updates remain, with 85 updates executing more
than one substep. Single-substep GPU median/p95/p99 is **9.27/13.73/15.67 ms**. Pressure per substep
is **1.58/2.53/8.73 ms**. Existing catch-up limits skip 1.726 seconds in this run; no new policy discards
time, but this is a remaining correctness/reliability limitation, not a successful no-skip result.

Compilation remains bounded to four in-flight programs and yields between programs; boundary program
preparation now uses the same scheduler rather than a bulk build. Public benchmark counters expose
active families, submission CPU and total compile wall time. Three's asynchronous graph build means
submission CPU is **not graph-build CPU**. Compile wall also includes yields/driver waits and must not
be presented as pure CPU. Real long tasks of roughly 51–173 ms still recur while preparing quality
programs; one submission reaches 199 ms during late spill. G2P compilation spans 717–1188 ms wall;
late pressure preparation spans 887–1094 ms. These are overlapping tasks and cannot be summed.
The late preparation overlaps four-step updates and GPU frames around 150 ms. It does not establish
that all that GPU cost is compiler work: evolving topology and sustained solver demand also contribute.

**Former corrective target (addressed above):** isolate setup/analyze/generate CPU within G2P and pressure programs,
then factor genuinely reusable interpolation/program units. Three already yields between build stages;
a single expensive stage can still monopolize JS. Also distinguish first-use rebuild on adopted storage
from queue/backpressure when late spill grows capacity. Do not increase compiler concurrency, lower
pressure accuracy, suppress time, or tune ordinary ~1 ms stages to conceal this tail.
Internal artifacts: `/tmp/flip-pacing-after/{summary,frames,spikes,resources}.json`.

### Validation and remaining acceptance

The forced growth fixture, source-free 2× coarsening/refinement time/mass/momentum invariant,
same-tier exact migration, hydrostatic/outlet projection and static/translating/rotating/accelerating
wall fixtures pass without relaxed tolerances. The quality invariant timed out in a concurrent browser
run, then passed alone; GPU reliability checks must run sequentially. Startup policy, capacity bounds,
resource lifetime and compiler cancellation/bounded-concurrency units pass. Build, TypeScript and
focused lint checks pass. Generated API references were refreshed; documentation build, all 35
documentation tests and 201,110 local link/anchor checks pass.

The teapot still uses tolerance 0 and fixed 28 pressure sweeps: there is no existing positive convergence
target authorizing an early exit. Warm pressure survives compatible growth; newly activated pages alone
are reset, while a changed physical boundary still invalidates the old gauge. Pressure dispatch follows
the compact resident topology, with per-cell wet-marker checks; admitted receiver pages can still incur
lane/stencil overhead. Narrowing this further requires a correctness-tested pressure-specific active set.
Multigrid should only replace iterative after matched frozen-input residual/divergence results justify it.
The opt-in `LIQUID_PRESSURE=1` diagnostic uses a fixed **0.03125** cell width, 256 resident-slot
capacity and 120 fixed warmup frames, then restores the same input pressure before each of seven
measured solves. Iterative 28 sweeps: retained-pressure **2.614 ms** GPU median, residual **0.00003183**;
cold **2.786 ms**, residual **0.051734**. Both have zero non-finite samples and maximum physical divergence
approximately 3, reflecting the nonzero density-restoration target rather than a zero-divergence fixture.
Mean projected divergence is 1.939 in this particular frozen plume. There is no positive configured
residual target permitting fewer sweeps; warm-start preservation demonstrably matters.

The nine-binding multigrid failure at this checkpoint is resolved by the completion follow-up above.
Results: `/tmp/flip-pressure-after/pressure.json`. A final eight-second fixed startup replay explicitly
retains requested/denied admission counters: **zero denied pages in all 480 updates**, maximum observed
requested demand 52 pages, zero GPU/browser errors. These are asynchronous diagnostics, not a GPU assertion
after each individual substep. Artifacts: `/tmp/flip-startup-admission`.
**At that checkpoint:** large quality graph-build stalls and late catch-up tails were still open;
the current completion measurements above supersede this status.

## Historical — GPU memory optimization

The three prior correctness gates are closed at their original tolerances. Shared scratch leases,
compact Surface Nets output, independent reconstruction/output reservations, finite gas pool ceilings,
and latency-aware storage-only growth are implemented. Velocity/color/parameter exports remain automatic;
lighting settings, simulation precision and configured reconstruction quality are unchanged.

**Acceptance is not an unconditional 60-FPS or deterministic tail-latency success.** The memory changes
are measurable and focused correctness checks pass, but real RAF spikes remain. The measurements below
separate controlled storage comparisons from evolving, adaptive interactive runs.

### Correctness closure and ownership

- Ambient scattering no longer adds already-unoccluded ambient irradiance back onto itself. The
  dense-medium ambient energy assertion and the remaining directional/probe/environment tests pass.
- Source-mask tests now put nonzero momentum on a splat that actually intersects cell centers, and
  read the active velocity node rather than assuming a particular backing attribute. Masked and
  exhaustive gathers agree for both advection methods with a nonzero velocity signal.
- The bounds-transfer test isolates translation from cell-width-dependent marker-density relaxation.
  Changing the outer pressure boundary invalidates its old pressure gauge. The original 2% speed
  threshold passes; the separate physical density/hydrostatic and 2× quality-transition tests remain.
- A prepared solver borrows compatible face/before-face/stencil backing; pressure, convergence,
  diagnostic reductions and multigrid correction state stay generation-specific. Compilation never
  executes the candidate. Real old/new invocations execute in queue order. Reference-counted leases
  outlive both submitted commands and compiler ownership; native storage dies only at the last release.
- An oversized donor can serve a smaller candidate during compilation. After adoption and retirement
  of the old generation, scratch is compacted once to the target layout. Rebinding keeps compute
  templates; topology/faces are reconstructed before use. A second queue fence protects the adopted
  generation's final uses of the borrowed backing. This is transition-specific workspace sizing,
  not a utilization-driven shrink loop. Disposed donors are never reused.
- The GPU lease fixture verifies shared identity, compilation with oversized backing, tight replacement
  and exact final-owner destruction after capacity migration. Explicit `growBrickPool` now awaits
  the requested tier even if an intermediate preparation was already in flight.

The 11-fixture focused set passes across the final run plus targeted reruns: hydrostatic/outlet,
comoving walls, source gathers, lighting, 2× liquid/gas migration, same-tier exact migration,
anisotropic reconstruction, both surface extractors, attachment and teapot/spout/spray. One same-tier
browser target closed during the combined run; its bounded rerun passed. No tolerance was relaxed.
Compacted output IDs are compared by world-space dual cell; they are intentionally not stable GPU
addresses. Additional capacity, native accounting, category-history and staged-fence unit tests pass.

### Pressure and preparation changes

Quality preparation waits for needed capacity preparation/adoption rather than canceling admission.
A quality candidate cannot block resident growth. Coarsened FLIP reservations count current resident
world support plus a complete one-brick receiver ring in the target lattice, rounded to a normal
geometric tier and clipped only by physical/native ceilings. That small metadata readback happens
in background preparation; the admission/guard kernels are unchanged. Refinement retains its
conservative nested support reservation and rejects unrepresentable demand.

Gas's growth ceiling is the geometric tier covering finite admissible positions:
`product(floor(maxBoundsAxis / worldBrickSize))`, bounded by device/user limits. Fixed domains use
their actual extent. Existing backing is not aggressively shrunk; unbounded domains keep dynamic
growth. Storage-only gas growth uses a two-frame minimum forecast lead plus measured preparation
time, instead of the old 0.75-second compiler allowance. The current FLIP capacity path is storage-only too;
its conservative forecasting lead is retained pending separate tuning.
The previous preview implementation briefly blocked admission; those results were rejected and are
not evidence of an accepted saving.

### Surface-buffer audit

All numbers are full-precision element widths. Capacities below describe the **new** owner; actual
peak generated vertices/triangles and capacities are emitted in the memory trace and pool summaries.

| Buffer | Stride / capacity | Producer → consumer | Lifetime and reuse |
| --- | --- | --- | --- |
| Primary packed field | 48 bytes / reserved cell | reconstruction/filter → extraction, shading, attachment | Persistent final field; includes support, color, momentum and curl |
| Filter scratch | 32 bytes / reserved cell | field filter → next filter | Dead after filtering; reused by topology smoothing when it fits |
| Positions | 16 bytes / output vertex | extraction/smoothing → shading, mesh | Persistent current mesh; compact IDs |
| Normals | 16 bytes / output vertex | attribute reconstruction → material | Persistent current mesh |
| Colors | 16 bytes / output vertex | attribute reconstruction → material | Persistent current mesh |
| Velocity | 16 bytes / output vertex | attribute reconstruction → flow shading | Persistent current mesh |
| Curl/deformation | 16 bytes / output vertex | attribute reconstruction → activity shading | Persistent current mesh |
| Smoothing intermediate | 16 bytes / output vertex | paired Laplacian passes | Aliases dead filter scratch; separate backing only if it cannot fit |
| Topology masks | 8 bytes / reserved cell | extraction → adjacency smoothing | Rebuilt every extraction |
| Cell-to-output map | 4 bytes / reserved cell | vertex compaction → stitching/smoothing | Rebuilt every extraction; zero means absent |
| Triangle indices | 12 bytes / reserved triangle | stitching → indirect indexed draw | Grows independently from field pages |

Field pages and output topology have separate high-water marks and geometric staged growth with
headroom. A wider reconstruction footprint therefore does not multiply every output buffer. The
standard 2048-page case formerly allocated six 16.78-MB output/intermediate buffers; a 98,304-vertex
output uses five 1.57-MB final buffers and a 4.19-MB map, with smoothing sharing filter scratch.
The representative adaptive run retained a higher output high-water mark, recorded below; its sampled
peak useful output was 28,398 vertices and 56,944 triangles. The conservative vertex/triangle ratio
and partial-field coverage forecast still leave room for further output-reservation improvements. Neither
resolution, anisotropy, interpolation nor lighting precision was reduced. Custom triangle/cell
extractors retain their layouts; compact extractors opt into the documented map contract.

### Controlled storage comparisons

Run the same fixture with `MEMORY_REPLAY=1 MEMORY_CONTROLLED=1 MEMORY_SECONDS=10`; add
`MEMORY_REFERENCE=1` for the reference. The script fixes CPU identity seed 137, 600 simulation
steps at 1/60 s, recorded teapot/domain events, cell width, resident preparation and viewport.
Volumes use fixed full render resolution rather than an FPS-dependent adaptive scale. The reference
uses independent pressure scratch and worst-case per-cell surface output reservations, including
a 524,288-triangle reserve. It is a controlled variant of the current implementation, **not an old
checkout or a byte-exact replay of every simulated field**. Parallel floating-point accumulation still
permits small state differences; do not interpret small timing differences as causal speedups.

Timed stepping precedes separate capacity/coarsen/refine lifecycle stress. All bytes below are decimal
MB of requested native storage, not driver residency/RSS. GPU figures are interval unions per frame;
CPU submission and RAF intervals are separate. Diagnostic staging allocations are included in counts.

| Reference → optimized | Liquid | Smoke | Fire |
| --- | ---: | ---: | ---: |
| Steady total MB | 522.75 → 503.75 | 131.69 → 131.69 | 287.07 → 287.07 |
| Total peak MB | 1288.23 → 1269.22 | 171.21 → 132.01 | 582.78 → 562.89 |
| Steady pressure scratch MB | 189.55 → 189.55 | 19.60 → 19.60 | 39.21 → 39.21 |
| Independent pressure scratch peak MB | 568.27 → 568.27 | 58.81 → 19.64 | 235.24 → 117.62 |
| GPU union median ms | 9.13 → 9.09 | 17.43 → 6.77 | 28.22 → 7.12 |
| GPU union p95 ms | 13.45 → 13.67 | 25.26 → 7.43 | 36.59 → 7.64 |
| GPU union p99 ms | 14.16 → 14.36 | 27.31 → 7.71 | 40.15 → 7.86 |
| CPU submission median ms | 3.40 → 3.30 | 2.00 → 2.00 | 3.20 → 3.20 |
| CPU submission p95 ms | 4.00 → 4.00 | 2.50 → 2.40 | 3.90 → 3.70 |
| CPU submission p99 ms | 4.70 → 4.60 | 3.20 → 2.80 | 4.50 → 4.30 |
| RAF interval p95 ms | 16.80 → 16.80 | 33.40 → 16.80 | 33.40 → 16.70 |
| RAF interval p99 ms | 16.80 → 16.80 | 33.40 → 16.80 | 50.00 → 16.80 |
| Teardown remainder MB | 47.04 → 47.04 | 9.14 → 9.14 | 24.92 → 24.92 |
| Native allocation / destruction count, reference | 5,196 / 4,652 | 1,439 / 1,114 | 2,501 / 2,038 |
| Native allocation / destruction count, optimized | 5,423 / 4,879 | 2,856 / 2,531 | 5,482 / 5,019 |

Smoke pressure scratch peak falls about 58.81 → 19.64 MB at the same capacity. Fire falls
235.24 → 117.62 MB. Liquid's forced 512→1023 resident replacement still needs a larger workspace
than its live solver can supply; that controlled peak remains 568.27 MB. Its controlled output
reservation falls 53.37 → 34.37 MB. Larger live liquid savings appear during real coarsening below.

Checkpoint wall intervals, reference → optimized (not CPU-only or GPU-only timings): liquid resident
512→1023 preparation 4116 → 3955 ms, prepared→adopted checkpoint 0.5 → 0.8 ms, and fenced refinement
1092 → 1168 ms. Fire capacity preparation is 9.8 → 12.7 ms and the adoption checkpoint 0.4 → 0.6 ms;
fenced refinement is 813 → 556 ms. Smoke's fenced refinement is 688 → 550 ms. These include queue
completion and lifecycle bookkeeping; they do not establish an equivalent improvement in a single
adoption frame. Compatible gas capacity growth still reports zero new compute programs in the
correctness fixture. Liquid's capacity compiler was removed by the current milestone above; these timings are historical.

**Inconclusive historical fire sample (not an active issue):** the reference recorded ~28-ms
median/36.59-ms p95 versus ~7.12/7.64 ms optimized.
That is too large to credit to these storage changes: the fixed-tier steady solver math is identical,
and both report identical steady requested bytes. Treat it as **inconclusive historical timing data**, not
an established fourfold speedup or an active unresolved release issue. The controlled liquid GPU p99 moves 14.16 → 14.36 ms, too small
for a single pair to establish a regression. At that historical checkpoint, strict no-tail-regression acceptance remained
open; current acceptance is stated at the top of this report.

**flipFluid:** current 885.92 MB, retired 383.30 MB at total peak. resident pages 12/512 (2.3%); surface pages
260/512 (50.8%). Prepared/retired sampled peaks 764.41 / 383.04 MB.

**volumetricSmoke:** current 132.01 MB at total peak. resident pages 226/512 (44.1%); lighting probes
294,912/294,912 (100.0%). Prepared/retired sampled peaks 0.00 / 0.00 MB.

**volumetricFire:** current 562.89 MB at total peak. resident pages 220/1,024 (21.5%); lighting probes
294,912/294,912 (100.0%). Prepared/retired sampled peaks 0.00 / 0.00 MB.

States distinguish current, prepared, retired-awaiting-fence and canceled compiler-owned storage in
new traces; shared allocations are charged once, preferring their live owner over canceled borrowers.
A zero sampled prepared/retired maximum does not mean no brief overlap: sampling is 10 Hz. The
exact total-peak allocation set and independent category peaks are retained. Category maxima now
replay annotation history rather than retroactively applying a resource's final owner to its lifetime.

### Current adaptive liquid and normal gas reservations

The latest 45-second adaptive teapot memory run records **313.32 MB steady,
1343.52 MB peak**, versus the previous attribution pass's 383.06 / 1669.11 MB.
Steady pressure scratch is 47.39 MB; at the exact
global peak it is 568.27 MB versus 757.82 MB previously.
Peak state is current 552.17 MB, retired 791.36 MB.
Teardown returns to 47.05 MB, with no device/page errors. These are
independent evolving runs; they support the footprint accounting but are not matched physics/FPS A/Bs.

- resident pages: 35/128 useful (27.3%), 96.12 MB.
- surface pages: 851/2,048 useful (41.6%), 131.57 MB; 10,640 generated / 393,216 reserved vertices, 21,104 /
131,072 triangles.

The earlier fixed-step live-domain gas comparison (adaptive renderer, not the matched comparison)
records smoke 231.60 → 163.99 MB and fire 190.38 → 122.58 MB after moving from 1024 to 512 reserved
pages. Their final resident counts were 224/512 and 249/512 with zero denied pages at the endpoint.
Do not infer zero denied pages throughout startup from that endpoint alone. These normal reservation
results justify the shorter storage-only forecast; they are not a matched raymarch performance claim.

### Remaining frame pacing and necessary memory

A separate 45-second real-RAF teapot run retains foam, spray and automatic tipping. GPU
median/p95/p99 are 8.66/55.10/79.75 ms; CPU
3.30/7.60/32.40 ms; RAF p95/p99
66.70/133.30 ms. Peak/native end memory is
1364.49/312.80 MB and teardown
46.53 MB. No device errors or non-finite pressure samples were
reported. At that historical checkpoint the strict 60-FPS gate remained open; current sign-off is above.

The remaining dominant peak is a real large-capacity migration plus compiler/fence retention, not
unexplained permanent storage. Different-capacity backing cannot always be borrowed, particularly
when the replacement is larger than the active arena. Persistent pressure/transport fields and
queued old bindings must coexist until migration finishes. Avoid another full scratch generation
before addressing that dependency; stable/chunked workspace backing would be a larger future change.

Other next work: correlate those remaining compiler/queue episodes with substep bursts; tighten
surface high-water predictions without allocation churn. The old fire timing outlier is inconclusive
historical data, not a current release task or evidence for a speedup. Dense render
exports, velocity and LightingGrid probes remain intentional feature cost. No opt-in export mechanism,
lighting reduction, lower precision, arbitrary memory cap or aggressive shrinking was introduced.

Detailed traces remain under `/tmp/fluid-memory-*`, outside ordinary PR output. Public `Benchmarks`
remains the source of compact memory/capacity counters. TypeScript, targeted lint, documentation
reference generation and the focused tests are checked separately from these timing experiments.

## Historical — shared memory attribution

The native audit now shares one semantic adapter for liquid and gas. Values below are **requested
GPU allocation bytes**, expressed in decimal MB, not driver residency or process RSS. Installation
occurs after renderer initialization, before fluid preparation. Construction can therefore read zero
without implying that the renderer has no allocations. The renderer/device stay alive during teardown.

Run `node apps/demo/benchmarks/fluids/diagnostics/fluid-memory.mjs /tmp/fluid-memory`.
`MEMORY_PRESETS`, `MEMORY_SECONDS` (45 by default), and `MEMORY_TRANSITIONS=0` select focused runs.
Ordinary RAF timing precedes separate forced capacity/coarsen/refine stress; no per-frame fence is added.
Full allocation identities, annotations, time series and lifecycle traces stay in the selected temporary
output directory. The root public `Benchmarks` tree exposes a `memory` collector with category bytes,
prepared/retired bytes and per-pool capacity, useful elements, utilization and bytes per element while
this diagnostic is attached. The UI does not own another set of measurements.

The generic tracker uses weak resource/CPU-attribute identity associations. It records native create,
destroy, pipeline and fence events, owner/purpose/generation, independent category maxima, and the exact
allocation set at the global total peak. Packed scalar/color/curl storage is divided into non-overlapping
segments; aliases are counted once. Snapshot category totals equal the physical requested-byte total.
First ownership discovery is backdated to creation; later lifecycle changes retain their own timestamps.

### Measured footprint and frame pacing

Same current teapot, smoke and fire presets, native Chromium/WebGPU, 800 × 600, 45 seconds each.
These are live, evolving workloads, not deterministic identical-density A/B states. Random emission,
catch-up and different quality-adoption times affect the surface/volume visible at the endpoint.
The fire reference was captured **after** removing the unused pressure buffer, so its before/after
pair is a control and does not measure that saving. Do not attribute its export-size change to an optimization.

| Metric | Liquid | Smoke | Fire |
| --- | ---: | ---: | ---: |
| Timed endpoint live MB, before → after | 695.40 → 383.06 | 387.96 → 391.02 | 199.23 → 190.38 |
| Settled after background retirement MB | 383.06 | 391.02 | not separately sampled |
| Whole-run peak MB, before → after | 1739.94 → 1669.11 | 1012.68 → 1021.71 | 497.03 → 488.18 |
| Endpoint attributed bytes | 98.97% | 99.92% | 99.37% |
| Post-teardown MB, before → after | 47.05 → 47.05 | 8.31 → 8.31 | 24.09 → 24.09 |
| GPU union median ms, before → after | 9.78 → 9.89 | 7.69 → 7.87 | 5.44 → 5.59 |
| GPU union p95 ms, before → after | 15.32 → 28.27 | 8.64 → 29.23 | 6.28 → 6.23 |
| GPU union p99 ms, before → after | 76.46 → 79.88 | 9.11 → 32.82 | 7.20 → 7.79 |
| CPU submission median ms, before → after | 3.30 → 3.20 | 1.70 → 1.90 | 2.80 → 2.60 |
| CPU submission p95 ms, before → after | 5.10 → 8.30 | 2.20 → 2.40 | 3.50 → 3.30 |
| CPU submission p99 ms, before → after | 32.70 → 37.00 | 3.80 → 4.00 | 4.60 → 4.40 |
| RAF interval median ms, before → after | 16.70 → 16.70 | 16.70 → 16.70 | 16.70 → 16.70 |
| RAF interval p95 ms, before → after | 16.80 → 50.00 | 16.80 → 33.30 | 16.70 → 16.70 |
| RAF interval p99 ms, before → after | 83.40 → 133.20 | 16.80 → 33.40 | 16.80 → 16.80 |

A lower memory footprint is not a frame-pacing success claim. In the first post-change run, smoke GPU
median increased from 7.69 to 11.04 ms: scene rendering increased from 5.04 to 6.96 ms and unclassified
GPU work from 1.79 to 2.73 ms, whereas pressure sweeps moved from 0.69 to 0.80 ms. Its endpoint domain
also changed from 80×64×80 to 72³ cells. Liquid still has preparation/catch-up outliers. Keep these
non-matching workload observations visible; they do not establish that removing an unused allocation
made pressure or raymarching slower. Nor do they demonstrate elimination of recurring spikes.

### Live and simultaneous-peak categories

Each entry is endpoint / **at the single global total peak**, in MB. Independent category maxima are
also emitted in `summary.json`; they occur at different times and must not be added together.

| Category | Liquid | Smoke | Fire |
| --- | ---: | ---: | ---: |
| Pressure solver scratch | 47.39 / 757.82 | 78.41 / 470.48 | 39.21 / 235.24 |
| Pressure fields | 2.10 / 33.54 | 4.19 / 8.39 | 2.10 / 4.19 |
| Velocity/grid fields | 25.17 / 402.46 | 33.55 / 67.11 | 16.78 / 33.55 |
| Collider/baked occupancy | 34.59 / 317.56 | 38.03 / 75.78 | 19.16 / 38.03 |
| Density/heat/color | 0.00 / 0.00 | 67.11 / 134.22 | 33.55 / 67.11 |
| Surface attributes/draw | 100.66 / 25.17 | 0.00 / 0.00 | 0.00 / 0.00 |
| Surface support + color/momentum | 33.55 / 8.39 | 0.00 / 0.00 | 0.00 / 0.00 |
| Anisotropy/filter scratch | 51.12 / 13.37 | 0.00 / 0.00 | 0.00 / 0.00 |
| Surface topology/directories | 15.97 / 4.88 | 0.00 / 0.00 | 0.00 / 0.00 |
| Source/event/transient | 4.54 / 4.54 | 33.60 / 67.15 | 16.89 / 33.67 |
| Transport/solver scratch | 2.36 / 33.80 | 20.97 / 41.94 | 10.49 / 20.97 |
| Derived density/color textures | 0.00 / 0.00 | 25.69 / 25.69 | 10.62 / 10.62 |
| Derived velocity textures | 0.00 / 0.00 | 12.84 / 12.84 | 5.31 / 5.31 |
| Lighting radiance/transmittance | 0.00 / 0.00 | 42.13 / 67.41 | 4.49 / 5.24 |
| Lighting hierarchy/intermediate | 0.00 / 0.00 | 23.18 / 37.08 | 2.48 / 2.89 |
| Renderer targets/depth | 50.96 / 50.94 | 9.63 / 9.64 | 26.75 / 26.76 |
| Particles + indices + children | 10.21 / 10.21 | 0.07 / 0.07 | 0.14 / 0.14 |
| Unattributed | 3.95 / 3.95 | 0.32 / 0.32 | 1.19 / 1.19 |

Small reduction, diagnostic and geometry allocations are recorded separately in the machine-readable
summary. No significant unknown allocation remains: the remaining unattributed fraction is under 1%.

### Capacity, overlap and retirement

**flipFluid.** resident pages: 30/128 (23.4%), 96.12 MB, 750955 bytes/reserved and 3204077 bytes/useful; surface
pages: 735/2,048 (35.9%), 201.30 MB, 98292 bytes/reserved and 273881 bytes/useful. At global peak: current 903.90
MB, retired 386.48 MB, prepared 378.72 MB; total/endpoint multiplier 4.36×. Largest live identities at that peak:
velocityCurrentAttribute (FLIP Fluid/FLIPSimulation, 134.09 MB); boundaryAttribute (FLIP Fluid/FLIPSimulation,
134.09 MB); pressure face/operator storage/stencilIndicesAttribute (FLIP Fluid/FLIPSimulation, 117.33 MB).

**volumetricSmoke.** resident pages: 263/2,048 (12.8%), 276.54 MB, 135031 bytes/reserved and 1051495 bytes/useful;
lighting probes: 518,400/518,400 (100.0%), 58.07 MB, 112 bytes/reserved and 112 bytes/useful. At global peak:
current 864.56 MB, retired 157.15 MB; total/endpoint multiplier 2.61×. Largest live identities at that peak:
boundaryAttribute (Volumetric Smoke/GasSimulation, 67.11 MB); visualAttribute (Volumetric Smoke/GasSimulation,
67.11 MB); replacement pressure capacity/stencilIndicesAttribute (Volumetric Smoke/GasSimulation, 58.72 MB).

**volumetricFire.** resident pages: 227/1,024 (22.2%), 138.71 MB, 135458 bytes/reserved and 611051 bytes/useful;
lighting probes: 55,296/55,296 (100.0%), 6.20 MB, 112 bytes/reserved and 112 bytes/useful. At global peak: current
409.57 MB, retired 78.61 MB; total/endpoint multiplier 2.56×. Largest live identities at that peak:
boundaryAttribute (Volumetric Fire/GasSimulation, 33.55 MB); visualAttribute (Volumetric Fire/GasSimulation, 33.55
MB); replacement pressure capacity/stencilIndicesAttribute (Volumetric Fire/GasSimulation, 29.36 MB).

A low utilization is evidence to investigate, not an instruction to shrink. Pool-byte totals can
include more than one live generation; inspect `state` and `generation` before multiplying an
aggregate bytes/page ratio by a single generation's capacity. Lighting uses actual allocated/required
probe counts and spacing; both demos currently use their velocity exports for density-noise stretching.
Those exports are not redundant for these workloads. These are intentional automatic feature costs; consumer registration or usage detection is not
part of the current optimization plan.

The transition trace records old steady → preparing → prepared → adopted → reclaimed, followed by
coarsen/refine checkpoints. `overlap` reports simultaneous current/prepared/retired bytes at the exact
total peak and separately sampled prepared/retired maxima (10 Hz, so brief states can be missed).
Gas compatible capacity replacement still reuses compute templates; forced pool growth deliberately
makes post-transition steady memory larger. Do not compare that final larger-capacity footprint to
pre-growth steady as though it were a leak.

A canceled capacity/quality preparation can retain resources past queue completion because an async
**CPU-side compiler still references its bindings**. The diagnostic waits for obsolete as well as
current preparations before checking teardown. Waiting only the current pool or a GPU fence falsely
reported ~1.19 GB retained in an 8-second liquid check; waiting both returned it to ~47 MB. This does
not justify early destruction. Diagnostic restoration uses weak owner references so canceled resource
owners are not kept alive just by the audit. Post-teardown remainders include the live renderer's
cached targets/depth, generic event scratch and timestamp/readback storage; they are not all fluid fields.
The 45-second range and reclaimed teardown are bounded-run evidence, not a proof against every long-run leak.

### Implemented optimizations and remaining opportunities

1. **Unused second pressure buffer removed in both solvers.** The solver uses persistent
   `pressureCurrent`; `pressureNext` was only allocated, cleared and migrated. Saving is exactly four
   bytes per reserved cell per live generation: 8.39 MB at liquid capacity 512×4096 cells and 4.19 MB
   at smoke capacity 2048×512. No pressure stencil, iterations or precision changes.
2. **Surface filter scratch reduced from three planes to two.** Filtering reads/writes scalar/color
   and momentum planes; curl/activity remains in the original primary field. Saving is 16 bytes per
   reserved surface cell: 16.78 MB at 2048×512 cells. Extraction and anisotropic support are unchanged.
3. **Bounded coarsened FLIP reservations.** A replacement pool cannot use more brick positions than
   fit inside the configured maximum physical bounds. Its ceiling is the normal geometric tier for
   `product(floor(maxBoundsAxis / worldBrickWidth))`, still capped by the device binding limit.
   The 10-unit teapot at cell width 0.125 and 16-cell bricks fits 125 positions, hence tier 128 rather
   than inherited tier 512. Refinement reads resident demand during asynchronous preparation and
   reserves up to eight nested pages per retained parent for a 2× refinement. Unrepresentable support
   rejects preparation instead of silently dropping fields. Raising maxBounds invalidates the target
   and allows later growth. There is no utilization-driven shrink loop or quality/domain reduction.

Ranked next work: shorten/coalesce overlapping preparations and avoid duplicate pressure scratch
(the dominant peak consumer); investigate generation-aware scratch reuse only where compiler and GPU
lifetimes genuinely do not overlap; investigate surface output reservations (six 16.78-MB attribute
buffers at the measured 2048-page tier); retain automatic render exports. Lighting storage is
visible but does not justify reducing lighting quality here. Foam/spray particle storage and children
are minor compared with pressure and surface pools. No speculative lower precision was introduced.

### Validation and limits

Native accounting tests cover weak/deferred association, alias deduplication, packed segments, exact
peak allocation sets, lifecycle state changes and independent category peaks. Capacity tests cover
bounded/anisotropic/unbounded domains, raising the cap and conservative refinement. Existing staged
allocation/fence tests remain enabled. GPU fixtures exercise hydrostatic pressure/outlet motion,
moving walls, 2× quality migration, surface reconstruction references, attachment, gas source transport,
lighting and same-tier exact field migration. Test failures and final counts are recorded below;
do not infer a green suite from the memory measurements.

The attribution pass ended with three failing fixtures. They are resolved in the latest optimization
section above; the original measurements are retained here as historical baselines. They do not
represent the latest correctness status or establish a current performance guarantee.

## Historical — previous 60 FPS reliability measurements

**Status: substantial runtime corrections, but the strict full-run 60 FPS target is not yet met.**
Do not use the previous ~10 ms median as an interactive-FPS claim. Measurements below include the
current lit/transmissive/distorted bubble foam, its renderer children, deformation/normal emission
filters, widened teapot, 20-second/45-degree automatic tipping, 32,000 marker ceiling, original
spray, adaptive domains and unchanged simulation/surface resolution. Reference viewport: 800 × 600,
local native Chromium/WebGPU. Timings are individual local runs, not cross-machine guarantees.

### Capturing spikes and resource lifetime

Run `apps/demo/benchmarks/fluids/diagnostics/teapot-reliability.mjs <output-directory>`.
The default records 45 wall-clock seconds using ordinary RAF and `system.update()`. `LIQUID_MODE=fenced`
runs 2,700 fixed 1/60-second updates for the attribution comparison. `LIQUID_NEIGHBOR_COUNTS=0`
disables the optional one-write-per-particle neighbor counter. `LIQUID_WARMUP=8` records the initial
eight seconds separately before a full 45-second measured RAF interval; it does not discard their traces.

The runner emits `summary.json`, `frames.json`, `spikes.json`, and `resources.json`. These stay internal,
outside ordinary benchmark/PR output. `LIQUID_SPIKE_MS` controls the GPU trigger, default 16.67 ms.
Each incident retains three frames before/after, its full per-pass timestamps and largest stage.
`checkpoints.jsonl` additionally streams a compact sample and resource events every 120 frames, so a
failed long-running browser does not erase all evidence.
Records include CPU submission, frame/update/render intervals, requested/executed/skipped simulation
seconds/substeps, system/child counts, FLIP resident capacity/pages, surface pages/cells/triangles,
query-grid cell width, anisotropic neighbor visits, collider pose, prepared/adopted quality descriptors,
pipeline creation, native allocation/upload/destruction and pending retirement/fence observations.

An eight-slot timestamp ring resolves asynchronously; a busy ring drops a **diagnostic sample**, never
blocks an update or reuses mapped storage. Queue completion is sampled every 120 frames without being
awaited by the RAF callback. Long tasks and device errors/loss are captured. GPU unions are calculated
per frame; stage medians must not be added. Public particle/page counters are asynchronous observations,
not a synchronous readback of the timestamped invocation. Optional neighbor statistics add a small
storage write/readback and are explicitly marked in the result. Frozen foam diagnostics occur after timing.

### Full-run before/after measurements

| Measurement, ms | Before, 45 s RAF | Corrected, 45 s RAF | Corrected, 2,700-step fenced |
| --- | ---: | ---: | ---: |
| GPU union median | 10.453 | 10.155 | 9.617 |
| GPU union p95 | 57.657 | 20.356 | 14.104 |
| GPU union p99 | 82.462 | 78.671 | 15.622 |
| GPU union maximum | 138.592 | 89.276 | 46.191 |
| CPU submission median | 3.1 | 3.1 | 2.7 |
| CPU submission p95 | 7.2 | 6.0 | 3.3 |
| CPU submission maximum | 588.5 | 294.4 | 26.7 |
| RAF interval median | 16.7 | 16.7 | not a RAF run |
| RAF interval p90 | 33.4 | 16.7 | not a RAF run |
| RAF interval p95 | 66.7 | 33.3 | not a RAF run |
| RAF interval p99 | 133.2 | 100.1 | not a RAF run |
| RAF interval maximum | 616.6 | 333.3 | not a RAF run |

The before/corrected RAF runs contain 1,932/2,227 measured frame intervals. Before: 1,280 exceed
16.67 ms, 248 exceed 20 ms, 194 exceed 33.33 ms. Corrected: 1,435 / 131 / 111 respectively.
The higher strict 16.67-ms count is compatible with more frames at nominal 60 Hz: browser timestamps
quantize normal intervals to 16.7 ms. Preserve raw counts; do not relabel those as GPU overruns.
GPU frames over 16.67 ms fell from 300/1,933 to 133/2,228; the fenced run had 23/2,700.

After the first eight seconds, the corrected RAF run has GPU p95 13.931 ms, CPU p95 3.6 ms,
RAF p95 16.8 ms and RAF p99 50.1 ms (2,065 frames). This is a separately identified subset,
**not** a claim that the whole run meets p95 ≤16.67 ms. The initial fine-tier pressure workload and
remaining compiler/catch-up episodes must remain visible in acceptance decisions.

### Separate steady RAF and idle control

A second run records eight startup/growth seconds and then **45 full measured RAF seconds**, with the
neighbor-counter hook disabled. It contains 2,510 measured intervals: median/p90/p95/p99/max
**16.7 / 16.7 / 16.8 / 50.0 / 250.0 ms**; strict >16.67 / >20 / >33.33 counts are
**1,577 / 52 / 45**. GPU union median/p95/p99/max is **10.165 / 14.147 / 29.464 / 59.845 ms**;
CPU median/p95/p99/max is **3.1 / 3.6 / 5.9 / 35.9 ms**. GPU coverage is 2,511 frames.
The idle 120-interval control in the same browser has median/p95 **16.7/16.7 ms**, p99/max 16.8 ms,
and zero >20-ms intervals. Thus browser timestamp granularity explains the raw nominal-60-Hz
threshold ambiguity, but **does not** explain the measured 50–250-ms workload tail. Those remain
real acceptance work; the headline status is deliberately not marked complete.

### Demonstrated causes and corrections

1. **Reconstruction spikes, not a covariance rewrite.** During a later spill, field reconstruction
   reached 74–76 ms at ~566k processed surface cells, while an adjacent ordinary frame cost ~1 ms.
   No new pipelines or substantial native allocation occurred on those incident frames. The auxiliary
   particle query hash had refined to 0.03125-unit cells while searching support of roughly 0.16 units
   or more. Each surface voxel therefore enumerated many tiny empty buckets. Its automatic minimum
   reference quality now follows `voxelSize × influenceRadius × queryCellsPerAxis`; power-of-two
   quantization gives 0.25-unit query cells for the demo. Exact distance filtering remains enabled,
   with no change to the simulation/surface lattice, kernel, support radius or neighbor budget.
   Explicit static quality and bounded-query settings retain their configured behavior.
2. **Unprepared quality adoption.** Deferring directory growth previously called `setBounds(oldBounds)`.
   That reinterpreted old rectangular coverage as a fresh quality target, bypassing the prepared
   replacement. A traced adoption built 39 pipelines and submitted for 588.5 ms. The fallback now
   resolves coverage at the current quality before setting bounds. The unit regression reproduces
   the old failure without a GPU. Final traced adoptions have ready, matching candidates; later
   changes submit in 3.2–4.1 ms. These whole-frame times are not isolated migration timings.
3. **Background preparation stalls.** Surface preparation compiled the complete graph batch in one
   call, and other preparation serialized driver round trips. Surface/pressure preparation now uses
   the shared yielding helper with at most four compilations in flight. Cancellation settles pending
   compilers before resources can retire. Fresh, zero-filled replacement fields no longer upload
   redundant CPU zeros; WebGPU guarantees zero initialization. This removes avoidable staging work,
   but does not make a single expensive TSL graph build interruptible.

### Native memory and retirement

The audit intercepts actual `GPUDevice.createBuffer/createTexture`, explicit destruction, pipeline
creation, buffer uploads and queue fences. Requested byte estimates include texture mips/layers and
sample counts; they are **not** driver residency or process RSS. Tracking begins after device init,
before scene/fluid/surface preparation. Allocation metadata does not retain resource objects.

Before correction, the 45-second run ended with **2.948 GB** of explicitly live workload allocations,
and **2.691 GB** remained after workload teardown. Compute-only attributes had relied on `.dispose()`
without a geometry owner to release their native buffers. Storage initialization now binds disposal
explicitly; pressure/reduction/multigrid owners release their storage, and sparse pools retain the
renderer needed to destroy buffers after their fences. Destruction also invalidates Three.js attribute
version/accounting metadata; otherwise reusing a released attribute could leave a missing native binding.
Repeated moving-wall fixture creation exposed this edge case and now passes. This changes ownership only, not solver maths.

The final corrected RAF trace peaks at **1.707 GB**, ends at **0.695 GB**, and leaves **46.65 MB** after
workload teardown, with no pending fences. The last five seconds fluctuate only between 695.53 and
695.80 MB; old/replacement pools are reclaimed rather than accumulating. Renderer/shared textures,
uniforms and diagnostic timestamp resources remain in that teardown snapshot; it is not a zero-byte
renderer-destruction test. `StagedGPUAllocation.status.retiredResources` explicitly reports resources
awaiting a retirement fence. The 45-second evidence supports bounded usage for this fixture, not an
unlimited-session or all-driver memory guarantee. No memory cap or quality reduction was introduced.

### Current foam cost

At the final frozen RAF checkpoint: **254 simulated markers, 527 generated children, zero overflow**;
surface query **0.0285 ms**, full attachment including query **0.0149 ms**, foam-only render **0.1038 ms**.
Full frozen scene rendering was **0.3970 ms** with foam versus **0.3331 ms** without its draw
(~0.064 ms difference, one local comparison). Query/attachment microbenchmarks are individually noisy
at this scale; the apparent ordering is not evidence that adding attachment makes a query cheaper.
The fenced checkpoint similarly measured query/attachment 0.0191/0.0210 ms and full scene
0.6807/0.5329 ms. These render comparisons retain the same frozen liquid/camera/lighting;
foam-only rendering includes clear/depth work and is not an additive marginal stage.

Live foam compute remains separately labeled `foam/simulation-and-attachment`; source selection is
included in secondary subsystem work. Renderer-child counters refresh asynchronously in ordinary
profiling; focused frozen benchmarks now additionally read the actual arena counters and overflow.
No foam aesthetic, selection, lifetime or attachment changes were made in this milestone.
The separate steady control's frozen checkpoint contains **255 simulated markers, 535 generated
children and zero child overflow** (the asynchronous UI observation was 529 children). Query/full
attachment measure **0.0214/0.0238 ms**, foam-only rendering **0.1540 ms**, and full scene rendering
**0.7402/0.5990 ms** with/without the foam draw. These are snapshot counts, not configured budgets.


### Remaining frame-pacing work

- The initial 0.015625-unit FLIP tier remains expensive while its automatic coarser replacement is
  prepared. In the final run it adopts at 6.39 seconds; the worst remaining GPU frames are pressure-led.
  This is a real initial growth/preparation cost, not an OS scheduling explanation.
- Some later compiler tasks still trigger 3–4 catch-up substeps. At 34 seconds, one frame measured
  53.81 ms total GPU, including 17.52 ms pressure across four steps, while the replacement was in
  pressure compilation. Other bursts have 10–14 ms pressure across four steps: distinguish repeated
  ordinary solver work from a single slow solve. Persistent program/binding reuse or finer-grained
  graph construction is the next preparation improvement; globally reducing pressure sweeps is not
  justified by ordinary-stage timings.
- One intermediate run had a 16.08-second RAF gap without a matching JS long task or comparable GPU
  interval. It is retained as a browser/host pacing incident, separately from the demonstrated CPU/GPU
  stalls. No device loss was observed. It must not be used to dismiss the actual application stalls.

### Correctness checks after optimization

- Exact query-index A/B: 0.03125 versus 0.25-unit bins produced relative field error **8.15e-10**,
  identical **1,980 triangles**, and no clipping/overflow. Full-neighbor covariance/geometry references
  pass for calm, translating, stretched and splashing fixtures.
- Sparse-aware hydrostatic/outlet fixture passes: normalized pressure gradient **0.998557**, sealed
  maximum divergence **0.000622**, maximum velocity **0.000192**, all **4,032** markers retained,
  **87** outlet markers and no floor leakage. The old dense-offset synthetic test was reading packed
  sparse buffers incorrectly; the standard test now uses the accepted sparse-aware fixture.
- Static/translation/rotation/acceleration moving-wall controls pass, including repeated workload
  destruction/recreation, mass retention, finite fields, penetration, surface coverage and collider reuse.
- Source-free 2× coarsening/refinement retains all **216** markers/mass, skips no simulated time,
  and satisfies the existing displacement/momentum/divergence limits.
- Surface attachment/query/rebinding, prepared GPU particle counts, material activity and both surface
  extraction regression checks pass. Tipping/discharge tests now use automatically collected mesh
  colliders and the current 20-second default; no numerical acceptance thresholds were relaxed.
- Timestamp interval-union/concurrent ring tests, native disposal/cache invalidation, bounded/cancelled
  preparation and staged retirement counters pass. Package build and targeted lint pass.

## Historical archive — earlier milestone measurements

All "current milestone", "remaining" and "next work" language in this archive refers to its historical
checkpoint, not today's release status. The following measurements predate the later reliability changes and final foam styling unless
explicitly stated otherwise. GPU stage medians are not additive; fenced timings are not interactive FPS.

### Historical 1. Startup performance

**Current milestone:** CPU profiling identified redundant CPU voxelization in
`SpatialEffect.syncGPUTransform` for geometry-backed `FluidCollider`s. The CPU profile spent about
11.45 seconds cumulatively in `ensureBakedField`, including repeated preparation/first-use work.
The collider now exclusively uses its existing GPU bake; custom CPU occupancy predicates retain their
original fallback. A regression test makes any geometry-backed CPU voxel query fail immediately.

The completion pass adds generic non-advancing preparation for native allocation/emission,
permanent/transient modifiers, collision/integration, render-time attributes and continuous subsystem
eligibility. This uses the ordinary GPU phase builders and their caches; module update callbacks
are not run. Preparation configures the renderer and tag/event registries before capturing programs.
Auto-collected collision backends can prepare their geometry before first use.

Remaining first-use causes were isolated and corrected:

- BVH packing can add an index to an unindexed model. Recording that finalized revision avoids a
  false first-update topology rebuild and seven dependent pipeline invalidations.
- Cold velocity/pressure clears now retain their ComputeNodes across preparation and actual use.
- Capped-bound reconciliation and both full/fresh-brick boundary programs are prepared explicitly.
- Repeated preparation reconciles particle-buffer identity before compilation. Surface clearing
  invalidates the query/hides the mesh immediately and defers empty draw arguments to their next upload;
  it no longer creates a clear compute pass after particle resources have been released.

| Current widened teapot, unchanged foam | Previous pass | Completion pass |
| --- | ---: | ---: |
| Preparation wall, ms | 1,704.8 | 2,097.7 |
| First populated update CPU, ms | 184.3 | 38.3 |
| First populated update fenced wall, ms | 197.2 | 48.3 |
| First populated render fenced wall, ms | 49.6 | 49.0 |
| End-to-first-populated-frame wall, ms | 2,087.1 | 2,322.1 |
| Prepared / first-update compute pipelines | 84 / 38 | 112 / 0 |

These are individual cold Chromium/WebGPU lifecycle samples at bake resolution 96. The extra
asynchronous preparation moves work before the first update; this sample does **not** show a further
end-to-visible latency improvement over the previous pass. The original duplicate-CPU-bake control
was 14,047 ms. Preparation/compiler latency and first material/render-pipeline compilation remain
possible improvements, distinct from allocation cost or steady simulation execution.

An actual warm reset/reprepare measured 4.4 ms reset, 1,025.4 ms preparation, 9.0 ms first-update CPU,
and 47.3 ms first-frame fenced, with **zero new compute pipelines**. A separate populated-state
re-preparation checkpoint retained exact marker state, bit-for-bit velocity/pressure buffers,
elapsed time and event-frame sequence.
The first-update compute preparation acceptance criterion is met for this current fixture, not a
promise that arbitrary custom callbacks, changed settings or newly encountered geometry need no compilation.

### Historical 2. Quality-tier-change performance

**Current milestone:** the live diagnostic reproduced `Incompatible pressure migration` during
same-tier resident-pool replacement. Logical dimensions can change while a capacity replacement
compiles; both its pressure descriptor and the live descriptor must follow their finalized sparse
layout before migration. Refreshing that topology metadata preserves retained world-cell addresses and
pressure without weakening compatibility checks. Same-tier layout and prepared-quality adoption now
also refresh the descriptor after installing the new layout. Errors include both dimensions/face counts.

The source-free 216-marker 2× coarsening/refinement invariant passes: full particle/mass retention,
zero skipped time, finite fields, and the existing world-displacement/momentum/divergence thresholds.
This test exercises explicit structural edits, which still have a cold path; it does not establish
zero-pipeline adoption for automatic changes. `teapot-milestone.mjs` separately records actual
automatic adoption events, whether replacement preparation was ready, CPU submission and new
FLIP compute pipelines. Background compilation, adoption and queue latency remain distinct.

The adoption trace identified five late pipelines, all in pressure solving: transfer-only preparation
suppressed the live reduction variants. Quality and capacity preparation now explicitly compile
those pressure variants too. A current 900-frame teapot validation recorded prepared changes
0.015625 → 0.0625 and 0.0625 → 0.125 with **zero new FLIP compute pipelines** and 1.0 / 0.8 ms
CPU submission for the adopting compute call. These are CPU call times, not queue-completion latency.
The final 45-second run repeated both prepared changes with zero adoption-time compute pipelines
and 1.1 / 0.7 ms CPU submission for the FLIP compute call. The source-free 2× invariant passes again.
Those CPU numbers do not include asynchronous preparation or queue completion, and do not establish
transition convergence/latency for every workload.

### Historical 3. Performance when fluid colliders move

**Problem:** moving/tipping a container can cause extra cost beyond stationary-collider processing.

**Current measured comparison:** one populated current teapot, 2,705 markers, emission stopped,
foam/spray retained, 80 updates per mode; ten measured GPU interval-union samples after forty
settling updates. Translation/rotation use small prescribed rigid transforms; tipping uses the scene's
normal tip control, speed limit and vertical lift. Modes are sequential, not identical replayed states.

| Motion | Full GPU union, ms | Boundary classification, ms | Pressure solve, ms |
| --- | ---: | ---: | ---: |
| Static | 5.275 | cached | 1.317 |
| Translation | 5.419 | 0.069 | 1.217 |
| Rotation | 5.646 | 0.069 | 1.221 |
| Tipping | 7.100 | 0.089 | 1.490 |

All four modes retained the same geometry-local bake objects. Backend full builds remained two
(teapot and floor), geometry refits remained zero, and rigid updates changed transforms only.
Tipping's particle-collision scope rose to 0.735 ms. Boundary classification is not the dominant
cost here, so this pass does not add dirty regions or approximate topology updates. Reproduce with
`apps/demo/benchmarks/fluids/diagnostics/teapot-motion.mjs`.

### Historical 4. Performance during normal processing

**Final current workload:** 2,700 fixed 1/60-second updates (45 simulated seconds), current widened
teapot, current cubic-in-out 20-second/45-degree tipping loop, original spray and enabled foam,
32,000 particle ceiling. Each frame fences the queue to bound backlog. Every 120 frames records
GPU interval unions, counts, bounds/quality, pressure, surface diagnostics and renderer memory.
Diagnostic readbacks are outside the timed GPU intervals. This is a paced workload, not an
unfenced interactive-FPS guarantee.

The full run passed with finite pressure/velocity samples and no surface page/triangle overflow or
clipped particles. Median full GPU union was **9.986 ms**. At 32 seconds it had 13,135 markers and a
12.688 ms GPU union; at 40/42/44 seconds the samples were **10.270 / 9.861 / 9.892 ms**. The old
persistent slowdown at forty seconds was not reproduced. Outlet counts reached 381 at the sampled
34-second checkpoint, with a reconstructed surface still present and unclipped.

At the 44-second checkpoint (10,374 markers), GPU scopes were:

| Stage | GPU ms |
| --- | ---: |
| Particle spatial index | 0.236 |
| P2G | 0.996 |
| Pressure | 1.523 |
| G2P | 0.424 |
| Density/separation | 0.690 |
| Anisotropic support | 1.085 |
| Surface field reconstruction | 1.038 |
| Surface field filtering | 0.470 |
| Surface extraction | 0.125 |
| Secondary spray/foam work | 0.690 |

These are one checkpoint's scopes, not additive medians. Boundary classification on a moving-vessel
sample was 0.116 ms. No repeated dominant steady-state bottleneck justified changing pressure quality
or another anisotropic reconstruction optimization in this pass.

**Historical incident motivating the current pass:** one 12-second sample reached 35.006 ms GPU,
including 21.272 ms reconstruction and 5.350 ms anisotropic support. The event-local follow-up and
identified query-index cause are documented above; proximity to a quality event was not used as proof.

Historical renderer accounting reached **3.91 GB**, with the fine pool reaching 1,023 slots.
The native create/destroy audit above supersedes interpretations of that counter: both retained
capacity and missing native destruction contributed. No persistent device failure occurred in the
earlier fixture; neither run proves unlimited-session safety.

### Historical 5. Gravity, pressure propagation and inadequate spout discharge

**Current hydrostatic decision tree:** after correcting its obsolete fixture URL and dense-versus-sparse
addressing assumptions, the broad 16³, 0.125-unit reservoir/riser/outlet fixture passes.
Normalized hydrostatic pressure slope is 0.998557; sealed maximum speed is 0.0001915 and
post-projection maximum divergence 0.0006216. Opening the outlet gives positive grid flux 0.0117983.
The full P2G/pressure/G2P/collision/separation fixture retains all 4,032 markers, equal sealed levels
within 0.0000034 world units, 87 discharged markers, positive integrated grid discharge, no floor
leakage and no non-finite samples. This does not demonstrate a general pressure-propagation defect.

**First demonstrated incorrect teapot layer:** the actual 48-texel occupancy bake disconnects the
interior open-face route near the spout lip at 0.0625-unit liquid cells. Raising only the bake to 96
restores that route. BVH centerline sweeps at particle radii 0.0425 and 0.025 are clear, and a swept
bottom-wall positive control hits. The preset therefore uses bake resolution 96, preserving its
surface thickness, pressure settings, emission and velocity. The probe uses geometry-interior intervals,
quadrature face openness and logical coordinates independent of resident slot packing; it correctly
allows the roof to end at the open lip. Resolution/coarse-grid limits still apply; this is not proof
of connectivity at every possible cell width, grid origin or tilt.

A final same-state teapot check at 12.5 seconds, 0.0625-unit cells, measured positive outward
vessel-relative grid flux **0.041825 world-volume units/second** through an interior spout section,
64 spout markers and 108 discharged outlet markers. The actual reconstruction contained **498 spout
triangles and 1,935 outlet triangles**, with zero page/triangle overflow or clipped particles.
This closes the grid/marker/visible-reconstruction consistency check, rather than inferring local
coverage from mesh bounds. The flux is a sampled cross-section integral, not a calibrated
head-versus-discharge curve. Reproduce with `teapot-discharge.mjs`.

### Historical 6. Contact-surface deformation when the container moves

**Demonstrated defect:** a face can be closed by a conservatively solid adjacent voxel while
its own face quadrature misses the wall. That face previously inherited zero velocity from its
fluid-side owner, treating part of a moving container as stationary. In the constant-translation
fixture, 164/300 sampled closed X-faces were wrong. Correcting this preserves rigid center velocity
for conservative closures and chooses the solid neighbor's velocity when the fluid owner has no
blocked face samples. Geometry occupancy and particle collision radii are unchanged.

The controlled fixture uses 1,000 markers, six rigid collider walls, no material activity normals,
64 fixed 1/120-second steps, no emission, and a plain reconstructed surface. Translation starts
with matched particle/container velocity. Acceleration applies the same explicit body acceleration
to the liquid and container as a comoving positive control; it is not an assertion that an
unforced accelerating container should have no sloshing.

| Fixture | RMS comoving position error | RMS velocity error |
| --- | ---: | ---: |
| Static | 0.000336 | 0.000627 |
| Translation, before correction | 0.061063 | 0.222128 |
| Translation, corrected | 0.000371 | 0.000671 |
| Matched acceleration, corrected | 0.000546 | 0.005504 |
| Rotation, corrected | 0.008928 | 0.025492 |
| Same rotation without colliders | 0.008260 | 0.029329 |

Corrected translation/acceleration have **zero wrong sampled closed-face velocities**, full mass/marker
retention and no wall penetration. Rotation stays finite and bounded, with maximum penetration about
4.6e-6 world units. All rigid cases retain one geometry build and zero refits. Post-projection maximum
divergence is below 0.005 in every acceptance case. Surface overflow remains zero.

The comparable collider-free rotational evolution shows that its residual deviation is not solely a
moving-wall frame/contact defect; a finite free surface is not constrained to exact solid-body rotation.
This corrects the demonstrated artificial contact disturbance without forcing liquid to move as a
rigid body or suppressing legitimate free-surface evolution. The original swept translation/rotation
and previous-pose tests also pass. `comoving-liquid.browser.test.mjs` retains these invariants.

### Historical 7. Foam appearance and visibility

**Milestone boundary:** the numerical and performance captures above used the original soft spray-texture
foam, including 251 foam and 247 spray particles at the earlier 26-second checkpoint. The focused
surface-attachment, query/rebinding, detachment and swept-contact tests passed before the visual restyle.

**Post-milestone styling:** foam now uses the bubble preset's lit circle sprites, spherical normals,
transmission map and existing normal map for distortion. The particles remain 0.06–0.12 units wide,
smaller than the bubble preset's 0.25–1 range. Color is white, alpha is 0.18 and transmission is
0.8. Soft-particle fading uses a short 0.02-unit distance to retain visibility at the water surface.
Distortion strength is reduced to -0.02 and multiplied by particle size through DistortionBySize.
Three visual children per parent, within radius 0.04, add overlapping smaller/translucent bubbles
without adding simulated particles. Existing foam emission, lifetime, surface attachment and selection
remain unchanged; bubble motion, collisions and audio were not copied.

The demo additionally filters eligible sources using the reconstructed surface's world-space outward
normal: `dot(up, normal) >= 0` allows upward-facing and vertical surfaces, while downward-facing or
invalid surface samples do not emit foam. This affects new foam emission only, not existing attachment.
Source activity now uses `minimumDeformity: 0.5` with the surface sampler, reading the same reconstructed
symmetric velocity strain as liquid shading. Absolute speed is no longer required; uniform translation
does not itself trigger foam. Public benchmark component names supply individual system particle counts
to the demo profiler, alongside the unchanged aggregate count.

The named counts exposed a cold-preparation counter-binding bug: foam had 256 live GPU markers while
the public allocation count remained zero. Generic preparation captured an allocation writer before
creating the actual particle capacity, leaving cached graphs bound to temporary counters. Preparation
now creates particle storage first. A deterministic GPU regression compares the public particle count
against actual alive slots and checks three renderer children per live source.

These appearance changes are now measured by the reliability runs above; they are not represented
by the earlier milestone timings. Persistent foam fields and additional behavior/clustering remain outside this change.
