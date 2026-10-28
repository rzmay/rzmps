# Fluid Performance And Resolution Diagnostic

## Current Status And Remaining Work

Retained after the latest audit because there are still bounded, actionable
performance improvements. The original corrective scope is substantially complete:
grid graph caching, sparse gas storage, source-support masks, combined gathers,
shared grid structure, procedural masking and GUI cleanup are implemented.
Scene-depth clipping and optional opacity-aware stepping are implemented too.
The historical proposals below are not an outstanding implementation checklist.
The teapot investigation is tracked separately in the liquid surface plan.

### Active Dispatch And Grouped Clears: Implemented

Gas cell and face kernels now use compact active-slot lists, with separate fresh
lists for initialization. GPU-written [indirect dispatch arguments][indirect]
schedule one brick per workgroup-row, retaining stable pool addresses and all
existing numerical operators. The small scheduling pass scans slots, not cells;
there is no CPU count readback or CPU dispatch per brick. Cell/face padding is
guarded independently, and zero occupied/new bricks produce zero-work dispatches.
The first schedule is initialized before even an empty marking dispatch.

Thirteen cell clears are grouped into two passes, with at most seven targets plus
the existing metadata binding. A separate face clear also uses only fresh slots.
All source, transport, pressure, collider, remapping, maxima and export cell work
uses compact dispatch. Dense output-texture clearing remains dense by design.

The default resident budget is now 512, capped by logical brick count; the demo
uses this library default rather than a bespoke 384-brick override. This is a
liberal reservation, not free memory: all pool field buffers remain allocated.
Users can explicitly lower `maxActiveBricks` to save memory. Larger cell depths
multiply per-brick memory eightfold; device storage-buffer limits still apply.
Changing the budget continues to rebuild and clear simulation fields.

Run `node tests/visual/gas-dispatch-review.mjs /tmp/rzmps-gas-dispatch` for the
matched-input reference comparison. It uses one controlled moving, buoyant source,
fixed side-16 bounds, 16 pressure iterations and eight active bricks. Pool-wide
reference kernels use the same allocator/operators, with the old thirteen clears.
The compact scheduling pass is present in both modes, so the reference slightly
overstates the old total by that scheduling cost. Both modes record five startup
updates, 55 warm updates and twelve timed updates. Native compute timestamps and
queue-fenced wall times are reported separately. The frozen clear microbenchmark
has no fresh pages and measures the steady-state skip/submission cost.

First complete isolated run, Apple Metal 3 / Chromium WebGPU, steady medians:

| Grid | Budget | Method | GPU Pool / Compact ms | Wall Pool / Compact ms |
| --- | ---: | --- | ---: | ---: |
| 2/4 | 32 | SemiLagrangian | 1.17 / 0.86 | 2.10 / 2.30 |
| 2/4 | 64 | SemiLagrangian | 1.86 / 0.88 | 2.20 / 2.30 |
| 3/4 | 64 | SemiLagrangian | 2.18 / 1.17 | 2.30 / 2.20 |
| 3/4 | 512 | SemiLagrangian | 12.43 / 1.24 | 12.70 / 2.20 |
| 2/4 | 64 | MacCormack | 2.13 / 1.19 | 2.50 / 2.30 |

At 512 reserved bricks, unchanged-page cell clears fall from about 1.36 to
0.09 ms queue-fenced. Compact dispatch largely removes the unused-capacity GPU
penalty in this controlled scene; small-budget wall times do not consistently
improve. Startup wall times still include graph/pipeline compilation and are not
reliably improved. These are not frame-rate predictions for the full 300-source/
second demo, other adapters, or densely occupied pools. Raw arrays and startup
samples are in `/tmp/rzmps-gas-dispatch/metrics.json`.

All five pairs preserve density, color, velocity and transient fields within
1e-5 (every nonzero address is compared), with zero overflow. The sparse regression
also checks noncontiguous slots, padded face kernels, immutable sentinel cells,
empty pools, reclamation/reuse and pressure continuity. Eight storage bindings
remain sufficient; no new buffer binding is required by cell/face consumers.

Final preset review: `/tmp/rzmps-gas-active-dispatch/metrics.json` and desktop/
mobile screenshots. Fixed and automatic bounds pass 2/5/10-second checks with
zero overflow, negative density or nonfinite fields. Automatic bounds had 280
active bricks at the startup checkpoint and 32-36 at later checkpoints. The
60-second numerical/source/collision suites, FLIP cap-policy regressions, library
tests, lint and documentation checks pass. These visual review timings are not
the matched-input performance comparison above.

### Remaining Candidate

**Skip guaranteed-empty ray intervals.** The renderer still samples uniformly
through empty portions of each volume box. A conservative visual-occupancy grid
plus brick-boundary traversal could skip these intervals while retaining the
current integration in nonempty regions. Include transient sources, provider
transforms, filtering support and renderer children; solver residency alone is
not a correct visual occupancy mask. This is a bounded renderer feature, but more
involved than the completed dispatch/clear changes. It helps sparse views, not
screen-filling fog, and needs image-equivalence tests.

Pressure was the largest remaining individual solver stage in the last stage
profile (about 1.22 ms at 3/4), but simply reducing iterations trades away
convergence. Multigrid, fully sparse FLIP fields, AMR, source scatter, and temporal
or reduced-resolution reconstruction are deliberately outside this small-pass
recommendation. Collider caching and RNG replacement are not priorities given
their previously measured/audited costs. The unmatched low-resolution source-mask
comparison also remains a measurement follow-up, not a demonstrated regression.

The active/new-slot and grouped-clear pass is complete. Reassess renderer cost
on the current demo before selecting empty-space skipping or another solver pass.

For current mask controls and preset defaults, see the
[workbench guide](README.md#filtering-and-density-controls). Strength is now a
mask exponent with separate contrast; opacity-aware marching defaults to off.
The measurements below retain their historical workload and tuning.

Investigated 2026-10-28. The correction-pass section describes implemented changes;
the original diagnostic below it is retained as the measured historical baseline.
See the [liquid surface plan](liquid-surface-construction.md) for meshing and
the earlier teapot spout measurements.
The later [gas-stage diagnostic](gas-stage-performance-diagnostic.md) profiles
individual solver stages and records the now-implemented opacity-aware stepping
and scene-depth clipping. Its current API/results supersede the proposals below.

## Correction Pass

The gas solver now uses GPU-resident sparse brick storage and sparse dispatches
for velocity, staggered faces, pressure, collision, density, temperature and
color. `ParticleSpatialGrid` remains its particle-neighbor index. Both it and the
new field-grid helper inherit `SpatialGrid`, sharing the brick/cell coordinate
structure, subdivision setters, locating and bounds normalization. Different
payloads/build pipelines no longer imply unrelated grid layouts.

Brick depth now has a real storage consequence for gas: increasing it adds more
logical bricks, while cell depth increases the samples inside each resident
brick. `maxActiveBricks` (now default 512) caps the resident pool. Requests come from
live sources and existing gas with a transport/stencil halo. Empty bricks are
reclaimed and reused; already emitted gas does not disappear when particles die.
Missing pages sample zero, not a reflecting wall. Pressure and transport access
neighboring bricks through the page table, including consistent shared-face
fluxes. Explicit domain caps/colliders remain independent of allocation edges.

Pool overflow is observable through `readGridDiagnostics(renderer)` and a warning;
excess requested bricks cannot be simulated until the budget is raised. Increasing
the budget or changing subdivision structure rebuilds and clears simulation fields,
as previous resolution changes did. This is uniform-voxel sparse tiling, not AMR.
The two exported volume textures remain dense RGBA16F for compatibility with
general volume consumers; clearing/exporting them is still a resolution-dependent
cost. Sparse storage does not yet imply a sparse ray marcher.

The allocator marks direct-indexed brick requests on GPU, preserves existing page
assignments, releases unused slots, and assigns free slots deterministically.
The small coarse page table does not need a full radix sort: requests are already
unique by address. No sort dependency was added without a benchmark proving it
would improve this workload. A larger future brick population may justify scan/
compaction and indirect dispatch; the current pool dispatch skips unused slots.

`ParticleSpatialGrid` now caches its five build graphs and updates dispatch counts
without rebuilding graphs for particle-count changes. Structural/configuration
changes invalidate them. Hash heads and links share one allocation, reducing
storage bindings. Sparse metadata is packed too, keeping kernels within WebGPU's
standard eight-storage-buffer limit. Higher-order scalar transport uses separate
density and color targets when necessary to stay within that limit.

### Procedural Gas Mask

`VolumeRenderer` exposes `noiseStrength` (zero by default), `noiseFrequency`,
`noiseSpeed` and `noiseOctaves` (one by default, maximum four). It reuses
`generateGPUParticleNoise4D`, the same MaterialX-based procedural helper used by
GPU force noise. Validation caught an existing bug: MaterialX accepts `vec3`,
so the old helper's `vec4` argument discarded time. The shared helper now blends
spatially decorrelated 3D noise slices with a C2 temporal curve. This is evolving
noise, not a claim of 4D simplex parity with the CPU helper. Spatial-only noise
is unchanged; animated GPU forces now correctly respond to time as well.
Animation follows simulation updates, not rendered-frame count.
Strength zero compiles out noise entirely; zero-density
samples skip its evaluation. No texture generation, upload, or new dependency
is needed. At time zero, the spatial sample matches the previous GPU helper.

This is optical-property perturbation: multiply sampled density by a bounded
animated noise factor, then perform normal opacity integration. It is deliberately
not wavelet turbulence or extra physics. Color is still normalized by the original
density, preventing erosion from making RGB brighter or darker independently.
No gas fields, particle values or collision geometry are changed by masking.
It is intended for gas appearance, not liquid simulation. The original teapot
discussion was about grid resolution only, not a suggested use of this mask.

This first procedural path requires `WebGPURenderer` (including its GLSL backend),
matching GPU gas use. Enabling it on the legacy `WebGLRenderer` throws explicitly;
unmasked volumes continue to support both renderers. Noise frequency and animation
are uniforms; enabling/disabling noise or changing octave count rebuilds the volume
material. The GUI exposes all four controls, plus independent ray quality settings.

### GUI Scope

Fluid modules now use a tuning allowlist rather than enumerating readable fields.
Pressure/source/transport/collision/bounds/quality settings remain editable, along
with managed Spatial Grid Options. Fields, page tables, scratch arrays, textures,
backend objects, counters, maxima, pending readbacks and cache keys are not controls.
The volume renderer already used explicit controls; only noise tuning was added,
not its source fields, bindings, meshes or caches. Both demo GUI implementations
and volume serialization are updated.

### Depth-Aware Rendering: Historical Proposal

The proposed opacity-aware variant is distinct from scene-depth clipping:
accumulated transmittance `T` falls as the ray traverses fog, so later samples
contribute less to the final image. This is optical depth, not camera distance
or a guarantee that the next region is dense. A dense front layer can be followed
by empty space, a thin colored feature, or bright emission.

For a later bounded experiment, keep fine steps at the visible front and grow
them gradually as `T` falls, with a strict maximum step size. Integrate each
sample using its actual segment length, for example
`alpha = 1 - exp(-extinction * segmentLength)`, including the final short segment.
Do not merely skip samples while keeping their old alpha. Terminate once the
remaining transmittance is below an explicit error tolerance; any color-error
bound also needs a bound on downstream radiance. Compare silhouettes, thin
layers, changing colors and animated masks against a fine-step reference.
Optical-depth adaptation can hide missed detail behind fog, but cannot guarantee
that large steps resolve high-frequency procedural noise. It is not implemented.

Unity HDRP's documented fog path instead uses a camera-frustum 3D lighting grid
with screen-resolution/depth-slice budgets and optional reprojection. Its depth
distribution and depth-aware reconstruction are not evidence that it uses this
specific opacity-driven per-ray step-growth heuristic. These approaches should
remain separate quality decisions in this library.

There are three separate optimizations, with different risk and acceptance tests:

1. **Clip the ray interval once using opaque scene depth.** The current WebGPU
   march already tests each sample against opaque depth; it is not depth-blind.
   Read the same depth snapshot once, convert to view-space Z using the camera's
   depth convention, and transform the local ray origin/direction into view space.
   Solve `tScene = (zScene - originView.z) / directionView.z`, then clamp the box
   exit to `min(tBoxExit, tScene - bias)`. Derive sample count and opacity-distance
   correction from this clipped interval, rather than spending samples and doing
   matrix/depth comparisons until encountering the surface. Handle sky depth,
   near-parallel rays, orthographic/reversed-depth cameras and camera-inside-volume
   cases explicitly. An earlier opaque surface must never expose gas behind it.
2. **Skip empty intervals with conservative volume occupancy.** Build a coarse
   maximum-density/occupancy hierarchy from final visual density, not just source
   particles or solver density. Traverse brick ray intervals using DDA; skip only
   intervals guaranteed to contribute nothing. Include every tag-matched provider
   and transformed renderer child. Erosion-only noise cannot fill empty space, so
   the same zero-occupancy test remains conservative. A density mapping curve may
   be nonmonotonic; do not incorrectly classify it using one arbitrary cutoff.
3. **Reduce screen-space ray resolution and depth-aware upsample.** Render
   premultiplied scattering/color and transmittance into a half-resolution target.
   Use full-resolution opaque depth (and optionally normals) for bilateral
   upsampling, rejecting taps that would place smoke across a geometry edge.
   Store ray entry/exit and representative scattering depth where needed: an
   ordinary color blur is not a valid depth-aware reconstruction. Start without
   temporal history. Later reprojection would need motion, history rejection,
   disocclusion handling and camera-cut resets. Thin objects, mixed foreground/
   background pixels and multiple overlapping volumes are difficult cases.

The first option is the smallest next renderer pass. The third needs extra render
targets/compositing and must not be slipped in as a depth-test flag. Acceptance
requires matching full-resolution reference images from high/low angles, with
opaque thin walls, floor intersections, camera entry/exit and overlapping fields.
Transparent surfaces that do not write depth require a separate ordering strategy;
opaque-depth clipping cannot solve all transparent-volume compositing.

For now none of these renderer changes is enabled. Use Maximum Ray Steps and Ray
Step / Cell manually. A frozen-field quality matrix in the benchmark measures
40/80/160/320 steps with noise off/on separately from solver updates, so increased
simulation resolution is no longer conflated with more expensive ray integration.

### Corrected Performance Results

The final queue-fenced run is `/tmp/rzmps-fluid-sparse-final/metrics.json` with
the same Apple/Metal 3 adapter, side-16 domains, 65 gas sources / 675 FLIP markers,
and 16 / 28 pressure iterations as before. All cases had zero brick overflow.
Values are short-run medians, not a sustained full-container frame-rate promise.

| Solver | Brick/Cell Depth | Axis | Update ms | Resident / Logical Bricks | Buffers MiB |
| --- | --- | --- | --- | --- | --- |
| Gas | 2/4 | 64 | 2.18 | 8 / 64 | 22.41 |
| Gas | 3/4 | 128 | 2.72 | 12 / 512 | 22.41 |
| Gas | 2/5 | 128 | 13.63 | 8 / 64 | 177.56 |
| FLIP | 2/4 | 64 | 2.72 | Dense fields | 16.34 |
| FLIP | 3/4 | 128 | 11.30 | Dense fields | 128.34 |
| FLIP | 2/5 | 128 | 11.58 | Dense fields | 128.34 |

Gas's dense export textures still add 4 MiB at 64 or 32 MiB at 128. Buffer
figures exclude them, as in the baseline. Particle-grid rebuild medians were
approximately 0.12-0.15 ms. More brick subdivisions are now the practical path
to finer gas cells without multiplying every resident brick's storage. More
cell subdivisions still multiply cells per resident brick eightfold. Raising
resident capacity also increases field-buffer allocation; it is a separate knob.
These fixed-iteration comparisons do not prove equivalent pressure convergence.

Frozen-field ray integration, gas 3/4 at 128, one noise octave, strength 0.7:

| Maximum Steps | Noise Off ms | Animated Noise On ms |
| --- | --- | --- |
| 40 | 0.63 | 0.67 |
| 80 | 1.15 | 1.24 |
| 160 | 2.21 | 2.36 |
| 320 | 4.24 | 4.71 |

`stepSizeMultiplier` was held at 0.1 to make the step cap relevant. The field,
camera, children and noise time were frozen during each render batch; pipeline
warmup was excluded. The 64 and 2/5 cases showed similar render costs at the
same step cap, despite very different solver update costs. This isolates the
two quality axes more usefully than comparing combined frame times.

For this plume, procedural noise adds about 0.09 ms at 80 steps after skipping
empty samples; it is practical enough to use now. Higher octaves and screen-filling
dense fog can cost much more, because more samples evaluate the helper. No fixed
texture was benchmarked, so this is not evidence that procedural noise is faster
than texture sampling. It removes texture-generation/upload complexity while
meeting the measured use case. Higher ray quality remains a manual GUI decision.

### Multiple Particle Grids And GPU Randomness

`ParticleSystem` caches managed `ParticleSpatialGrid` instances by options.
Modules with matching options reuse one grid; differing configurations can own
separate grids and incur separate allocation/build work. Storage bindings are
counted per shader, not cumulatively across all modules. A kernel referencing
only its own grid does not bind every grid in the system. A kernel querying two
distinct grids would bind both sets of resources and must respect the device's
limit. Packing hash heads and links removes one binding per queried grid; it does
not eliminate the other coordinate, bounds and particle-payload resources.

GPU dynamic ranges, random sets, emission and renderer children already use
Three's stateless `hash()` implementation: an integer PCG-style permutation with
two multiplications, additions, shifts and XORs, followed by float conversion.
Unlike the former CPU default generator, this creates no generator object,
performs no string seeding and maintains no per-particle random-state buffer.
No Tyche-i replacement was made: there is no analogous setup cost to remove,
and adding mutable RNG state would add memory/dependency costs. This is a source
audit, not a benchmark proving the current hash is optimal. Revisit only if
profiling identifies random arithmetic, rather than noise or memory traffic,
as a significant cost.

Verification includes eight-buffer-limit validation, exact pressure residuals
across sparse brick boundaries, source alpha/lifetime/collision, retained gas
after source death, dissipation/reclamation/reuse, bounded higher-order transport,
grid changes, a 60-second continuous plume, and WebGL/WebGPU volume regressions.

## Historical Baseline Findings

1. Brick and cell subdivisions currently contribute only their sum to the
   fluid resolution. `2/4` is 64 cubed; `3/4` and `2/5` are both 128 cubed.
   There is no independently allocated sparse brick layer in the fluid solver.
2. Particle lookup is sparse, but velocity, pressure, divergence, collision,
   density, color, and output textures are dense. One additional subdivision
   means eight times the cells, not a small increment in quality/cost.
3. Gas does expensive particle-neighbor queries from every voxel, including
   empty space, for simulation sourcing and render-time visual sourcing.
   Optimizing pressure alone will not remove this cost.
4. Spatial-grid rebuild also constructs five fresh TSL compute graphs on every
   rebuild. Submission timings indicate appreciable CPU-side overhead even
   with very few source particles. Graph reuse deserves a separate bounded fix.
5. Render-only 3D noise is a well-established way to add apparent detail without
   refining pressure. It cannot open a blocked liquid spout or refine collisions.

## Reproducible Measurements

Run `node tests/visual/fluid-performance-review.mjs /tmp/rzmps-fluid-performance-final`.
The harness uses the actual WebGPU presets, deterministic random numbers,
60 warmup updates and five batches of six timed updates at 1/60 second.
It separately measures repeated renders and standalone particle-grid rebuilds.
Each timed batch begins/ends with `queue.onSubmittedWorkDone()`; field/particle
readbacks and screenshots are outside the timed intervals. Actual resolution
is asserted: the FLIP factory does not accept simulation options, so its grid
override must be applied through `setSpatialGridOptions` in the test fixture.

Environment: headless Chromium, Apple adapter, Metal 3. These are queue-fenced
wall-clock throughput measurements, including CPU submission, not hardware GPU
timestamp queries. They are not interchangeable with interactive demo FPS.
Cases run sequentially; thermal state, JIT, shader caches, and graph allocation
cause variation. Do not infer a brick-versus-cell advantage from small differences
between identical total depths. Full steady-state filling is not benchmarked.

Final unmodified-code run, median milliseconds per operation:

| Solver | Bricks/Cells | Actual Axis | Update | CPU Submit | Render | Grid Rebuild | Buffers MiB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Gas | 2/4 | 64 | 26.88 | 25.18 | 1.67 | 11.12 | 44.20 |
| Gas | 3/4 | 128 | 101.43 | 9.85 | 2.83 | 4.87 | 352.76 |
| Gas | 2/5 | 128 | 111.92 | 13.27 | 4.83 | 6.95 | 352.76 |
| FLIP | 2/4 | 64 | 5.50 | 4.98 | 0.58 | 4.23 | 16.34 |
| FLIP | 3/4 | 128 | 13.80 | 5.95 | 0.70 | 5.17 | 128.34 |
| FLIP | 2/5 | 128 | 15.45 | 7.42 | 0.87 | 6.00 | 128.34 |

All domains were side 16, cells 0.25/0.125. Gas had 65 surviving sources and
16 pressure iterations; FLIP had 675 markers and 28 iterations at measurement
end. Gas uses the checkerboard, FLIP the real teapot collider. Their costs are
not a solver-to-solver comparison under identical conditions.

Buffer figures count unique resident simulation and nested query-grid storage
attributes, not total VRAM. Gas additionally has two RGBA16F 3D textures:
4 MiB at 64, 32 MiB at 128.
Particle storage, renderer storage, driver allocation, shader caches, collider
bakes and CPU typed-array mirrors are excluded. Particle-grid storage itself
stayed approximately 7 KiB for gas and 220 KiB for FLIP, independent of depth.
The FLIP particle-separation scratch allocation is included in these buffers.

The gas 64 CPU times increased within this run; an earlier run's median was
13.82 ms/update. The raw arrays are retained, rather than hiding this instability
behind an FPS claim. Gas 128 remains expensive in both runs. Cold navigation
to readiness ranged about 0.7-3.3 seconds and includes imports, scene loading,
CPU collider baking and initial rendering. The separate 60-step warmup was
about 0.4-0.7 seconds for FLIP and 1.0/7.2-7.7 seconds for gas 64/128.

Artifacts: `/tmp/rzmps-fluid-performance-final/metrics.json` and per-case PNGs.
These temporary paths are reproducible local outputs, not checked-in assets.
No default quality, collision behavior, bounds, or source settings were changed.

### What To Profile Next

`ParticleSpatialGrid.getBuildNodes()` recreates reset, reduction, bounds/radius
finalization and insert graphs. Its subdivision fields affect `cellsPerAxis`;
the hash capacity depends on particle capacity, not the number of voxels.
The neighbor query visits exact cell coordinates and traverses hashed linked
lists. Hash collisions increase candidate work even in spatially empty regions.

At gas 128, repeated gather passes over 2,097,152 voxels dominate a plausible
optimization target: the source population is only dozens of particles. Measure
source gathers, visual gathers, advection, solid updates, projection and texture
export individually with timestamp queries before assigning exact percentages.
Do not subtract standalone grid time from full update time as if costs were
independent: cache state and CPU/GPU overlap differ.

The harness supports `PERF_CACHE_GRID=true` to reuse unchanged build graphs in
the test instance only. Its key includes grid revision, particle-buffer identity,
buffer revision and dispatch count. It is an attribution experiment, not a
production cache: changing particle count still invalidates it, and production
reuse must account for options captured while constructing shader graphs.

The experiment was run separately with all six cases. Median queue-fenced grid
rebuild fell to 0.20-0.33 ms (CPU submission approximately 0.02-0.07 ms). Full
updates were 6.77 ms for gas 64, 119.90/127.47 ms for gas 128, 3.68 ms for FLIP
64 and 13.72/12.97 ms for FLIP 128. Gas 64's CPU submission fell to 0.63 ms.
Raw artifacts: `/tmp/rzmps-fluid-performance-cached/metrics.json`.

This confirms avoidable graph/submission work, but does not demonstrate a GPU
speedup at high resolution: gas 128 remained around 100-130 ms with substantial
run-to-run variance. Keep graph reuse and dense-kernel optimization separate.
The uncached grid's cost cannot be explained by particle count alone when a
cached identical workload finishes in a fraction of a millisecond.

## What Established Systems Actually Adapt

### Blender

[Adaptive Domain][blender-adaptive] crops the active gas domain using an emptiness
threshold and a voxel margin; Add Resolution permits additional extent. This
is active-domain cropping, not arbitrary coarse/fine AMR. [Noise][blender-noise]
adds higher-resolution wavelet-turbulence detail while retaining the base motion.
Resolution Divisions and Noise Upres Factor are separate controls.

Application here: preserve world-space cell size while changing an integer
active window, using density/temperature/velocity activity rather than only live
source particles. The current fixed-resolution power-of-two growth instead
changes cell size when bounds grow. Shrinking a side-16 grid to side 8 at the
same resolution gives a local resolution improvement but sacrifices coverage;
it does not reduce the allocated cell count. Rectangular active windows or
fixed-voxel sparse bricks are needed for actual empty-domain work savings.

### Niagara / Unreal

The documented [Niagara Fluids grid][niagara] exposes World Space Size and
Resolution Max Axis; rendering has independent cell-relative step spacing.
These controls should not be advertised as automatic AMR. Unreal also has
[heterogeneous-volume acceleration and Sparse Volume Textures][unreal-volume],
but rendering/imported-cache sparsity is not evidence that every Niagara
simulation template skips empty solver cells.

Application here: separate simulation voxel size, active coverage, memory budget
and rendering sample quality. Preserve open/closed boundaries and cap policies.
A coarse occupancy/max-density hierarchy can skip empty ray intervals without
changing particle neighbors or pressure. Rebuild it conservatively as gas moves.

### Unity

[HDRP fog][unity-fog] uses a camera-frustum volume with screen-resolution and
depth-slice budgets. [Local Volumetric Fog][unity-local] supports distance fading
and tiled/scrolled 3D density masks. These are rendering controls, not a native
adaptive FLIP solver. Do not conflate HDRP, VFX Graph and third-party Obi.

Application here: screen-space volume rendering quality can vary independently
of the simulation. Reduced-resolution ray marching with depth-aware upsampling
is a plausible later renderer optimization; preserving opaque depth occlusion,
thin geometry and temporal stability is required. Camera-dependent solver cells
would be a poor default for persistent physical simulation.

## Shared Structure: Composition Before A Superclass

A particle hash answers neighbor queries; a volume owns sampled fields. Neither
is inherently a subtype of the other. Prefer an immutable/shared grid-layout
description (proposed, not implemented) containing origin, world-space voxel
metric, integer coordinates, brick extent, bounds, revision and budget. Separate
particle-index and dense/sparse-field storage can compose that layout.

Both can share coordinate conversion, quantized growth/shrink hysteresis,
allocation diagnostics and revisions without sharing occupancy semantics:
particles can die while emitted gas remains. A sparse volume must keep bricks
alive based on its fields, not just particle occupancy. A later surface renderer
can share alignment while choosing finer reconstruction voxels.

Avoid a general base class until two real storage implementations need common
lifecycle behavior. A base class alone cannot turn dense buffers into sparse
ones. True multilevel AMR also requires conservative coarse/fine transfers,
pressure coupling, flux treatment and collision halos; defer that beyond a first
uniform-voxel sparse-brick implementation.

## High-Resolution Noise Without High-Resolution Physics

Yes. Unity's [density mask][unity-local] is a close API precedent. [GPU Gems
volume perturbation][gpu-gems] explicitly combines a coarse macrostructure with
animated 3D noise for microstructure. Blender's wavelet implementation and the
original [Wavelet Turbulence paper][wavelet] go further: they synthesize coherent
missing velocity detail from low-resolution flow, rather than simply multiplying
density by unrelated noise. They should not be described as the same algorithm.

Suggested bounded first experiment belongs in `VolumeRenderer`, so any volume
provider benefits, with proposed controls for texture, strength, scale and scroll.
Sample a tileable 3D noise texture in stable simulation/world coordinates and
multiply density before optical integration. Use one factor for density-weighted
color contribution too; do not darken RGB independently or alter physics fields.
At strength zero, output must match today's renderer. Zero density remains zero.
For a mask in [0,1], this erodes density; a mean-one modulation is a distinct
artistic mode, not implicit mass conservation. No normalization requirement is
imposed on renderer children, which deliberately increase density.

A 128-cubed R8 texture is about 2 MiB before mips, vastly less than refining all
simulation buffers. One lookup per ray sample still has a real render cost;
multiple octaves/children multiply it. Subcell noise also needs sufficiently
fine ray sampling to avoid aliasing, so higher apparent detail is not free.
Scrolling can look like smoke sliding through a stationary pattern. A second
experiment can advect texture coordinates on the coarse grid, with reset/blend
cycles, to improve coherence. This adds state and must be budgeted separately.

Masking cannot create resolved buoyancy, velocity eddies, subcell pressure paths
or better liquid collisions. It is appropriate for gas appearance, not a fix
for the teapot's coarse solid mask. Noise-coordinate warping can cross walls;
simple multiplicative masking cannot create density where the sampled base is
zero, though interpolation and render children already have their own leakage
tradeoffs. Evaluate silhouettes, interior detail, color, depth and temporal motion.

## Prebuilt Libraries

| Candidate | Useful Capability | Integration Assessment |
| --- | --- | --- |
| [NVIDIA Flow][flow] | Dynamic sparse voxel blocks and GPU fluid operators | Native HLSL/Vulkan/DX12; architectural reference or substantial port, not a browser dependency. |
| [OpenVDB / NanoVDB][openvdb] | Sparse volume layouts, tools and portable GPU-oriented storage | C++ ecosystem; not a drop-in mutable WebGPU gas solver. Useful for layout/cache interchange research. |
| [webgpu-radix-sort][webgpu-sort] | JavaScript/WGSL key-value sorting and prefix scans | Closest practical component for cell sorting, active-brick compaction and surface allocation. |
| [wgpu_sort][wgpu-sort] | Rust/WGSL radix sorting, indirect dispatch | BSD-2-Clause reference; Rust host and subgroup assumptions need adaptation/testing. |

Flow documents dynamically allocated 32x16x16 blocks and a capped pool. That is
the closest sparse-solver architecture in this review. Use current Flow in the
PhysX repository, not the older GameWorks package with different licensing.
OpenVDB's current repository declares Apache-2.0. The JavaScript sort package's
[manifest][sort-manifest] declares MIT; audit the actual shipped source/license
and pin a revision before adoption. It requires native GPU buffers and the same
device/queue as Three.js: never create a separate device for existing buffers.
Three storage-buffer interoperability and command ordering need a small prototype.
No candidate was installed or performance-tested as part of this diagnostic.

Sorting/scan can compact active cells and replace long hash chains, but a full
sort may lose to the existing hash for small populations. Benchmark measured
query workloads rather than assuming a more complicated algorithm is faster.

## Recommended Corrective Scope

1. Reuse spatial-grid build graphs with explicit invalidation and mutable dispatch
   counts. Verify allocation/pipeline counts stop growing with frame number.
2. Limit gas source and visual gathers to conservative source-active tiles before
   tackling sparse pressure. Keep advected gas active after sources leave; a
   source-only tile mask must never erase or stop already-emitted gas.
3. Test compact initial FLIP bounds and independent collider-bake quality against
   spout connectivity and thin-wall containment. Retain the explicit growth cap.
4. Prototype optional render-only noise at base resolution with fixed sampling
   quality, then compare image quality and queue-fenced cost to real 128 grids.
5. Only if needed, introduce uniform-voxel sparse field bricks with halos and an
   allocation budget. Pressure must connect across bricks; include velocity-only
   support, advection travel and diffusion reach, not just visible density.

End point for the next small pass: no per-frame grid graph reconstruction,
bounded source-gather work, recorded 64/128 timings and unchanged collision/tag/
color regressions. Sparse pressure, AMR and liquid meshing are separate passes.

## Sources

[blender-adaptive]: https://docs.blender.org/manual/nl/4.2/physics/fluid/type/domain/gas/adaptive_domain.html
[blender-noise]: https://docs.blender.org/manual/en/latest/physics/fluid/type/domain/gas/noise.html
[niagara]: https://dev.epicgames.com/documentation/en-us/unreal-engine/niagara-fluids-reference-in-unreal-engine
[unreal-volume]: https://dev.epicgames.com/documentation/unreal-engine/heterogeneous-volumes-in-unreal-engine
[unity-fog]: https://docs.unity3d.com/Packages/com.unity.render-pipelines.high-definition@14.0/manual/Override-Fog.html
[unity-local]: https://docs.unity3d.com/Packages/com.unity.render-pipelines.high-definition@14.0/manual/Local-Volumetric-Fog.html
[gpu-gems]: https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-39-volume-rendering-techniques
[wavelet]: https://www.cs.cornell.edu/~tedkim/WTURB/
[flow]: https://nvidia-omniverse.github.io/PhysX/flow/index.html
[openvdb]: https://github.com/AcademySoftwareFoundation/openvdb
[webgpu-sort]: https://github.com/kishimisu/WebGPU-Radix-Sort
[sort-manifest]: https://github.com/kishimisu/WebGPU-Radix-Sort/blob/main/package.json
[wgpu-sort]: https://github.com/KeKsBoTer/wgpu_sort
[indirect]: https://developer.mozilla.org/en-US/docs/Web/API/GPUComputePassEncoder/dispatchWorkgroupsIndirect
