# Fluid Performance And Resolution Diagnostic

Investigated 2026-10-28. This is a diagnostic and a proposed corrective scope,
not a claim that sparse simulation or noise up-resolution has been implemented.
See the [liquid surface plan](liquid-surface-construction.md) for meshing and
the earlier teapot spout measurements.

## Main Findings

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
