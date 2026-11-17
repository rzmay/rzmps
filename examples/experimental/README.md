# Gas completion milestone: validation and remaining issues

Gas simulation is now covered by the normal full benchmark suite. This report focuses on lifecycle
stalls, sustained costs and the separately reported persistent viewport freeze. It replaces the
historical investigation log. All timings below are local native Chromium/WebGPU observations,
not guaranteed FPS or total VRAM measurements.

## Current performance picture (2026-11-16)

The latest controlled A/B includes velocity export and render work, with a filtered velocity texture
replacing the earlier sparse-buffer render sampler. Earlier camera-position measurements are retained
below with their original settings. Earlier simulation-stage,
lighting and stress captures remain below with their original scope; they were not rerun for this report
update and must not be treated as a fresh additive frame breakdown. Source inspection confirms the current
paths and identifies the following workload-dependent costs:

| Area | Current work / evidence | Remaining opportunity or limitation |
| --- | --- | --- |
| Screen-filling raymarch | More occupied-gas samples per screen pixel; measured camera sweep below. | Fixed downsampling or a tighter render-time target; reconstruction trades fine screen detail for fewer rays. |
| Velocity-stretched mask | One hardware-filtered velocity texture lookup at each enabled mask point; export is measured too. | Implemented below: lower repeated ray cost, additional dense export/clear bandwidth and texture memory. |
| Procedural density mask | 4D procedural noise per nonempty masked stratum; octaves multiply that work. | No new isolated octave/noise benchmark in this pass; temperature modifiers do not add another noise evaluation. |
| Lighting while raymarching | Isotropic LightingGrid uses one filtered radiance fetch; nonzero anisotropy weights directional bins. | Exactly zero-opacity samples now skip lighting/shadows. Fully emissive samples still evaluate external lighting: a bounded future candidate, not a measured win. |
| Simulation pressure / transport | Work grows with processed pages/cells, solver sweeps and advection method. | Earlier small-N stage table is diagnostic only. Compare multigrid at equal residual/divergence before promoting it for another workload. |
| Derived volume export | Density/color textures are cleared over the full valid export rectangle, then resident cells are exported. Curl export also samples neighboring velocities. | Sparse simulation storage does not make dense export/occupancy work sparse. Remeasure clear, export and renderer occupancy separately before changing their layout. |
| LightingGrid updates | Probe coverage, direction count, interval samples and propagation determine update work. | Controlled factoring comparison and evolving-scene timings below measure different workloads. |
| Sources and custom rules | Source gathering follows particles/support; custom GasModule neighborhood queries add sparse reads at existing callback sites. | Fused scalar targets and multiple coefficient sites can repeat custom code. The query accessor itself adds no reads when unused. |
| CPU appearance synchronization | Function-valued parameter tables can be resampled on the CPU during synchronization, even when GPU bindings persist. | A source-inspected candidate, not a demonstrated dominant cost; distinguish it from per-ray GPU vector fetches. |
| Transitions / preparation | Tier adoption, resource allocation, compilation and first-use collider baking can hitch independently of steady FPS. | The retired-pressure-buffer render freeze is fixed; the older long-run freeze report remains a separate unproven failure. |

The simulation's ordinary fixed-budget Auto pressure path still selects iterative for low sweep budgets;
multigrid crossover requires sufficient workload, useful levels and tolerance-driven solving. Sparse
admission/domain work remains separately measured and is not implicated by the render-only A/B.

## Lighting defaults follow-up (not benchmarked)

LightingGrid now defaults to `levels: 2` (cascades), `directions: 4`, `samplesPerInterval: 4`, and
`scatteringIterations: 1`. Demo/GUI overrides follow these values; smoke/fire retain only their explicit
0.25-unit probe spacing and sixteen-unit lighting distance. The measurements elsewhere in this report
predate this default change and are not measurements of the new defaults. No benchmarks were run for it.

Code-based expectation: directions is the strongest first tuning lever. Probe/bin injection and merge
scale with direction count; per-light directional normalization and scattering's mean-over-bins loop
also introduce direction-count-squared work. Changing the demos from twelve to four finest directions
reduces those respective portions by about 3x and 9x, not the entire lighting or frame time. With a scalar
direction count, coarse counts double, so the new two cascades use four/eight directions.

Interval samples scale the extinction integration part of injection roughly linearly (eight to four
halves those samples), while light evaluation and merge remain. Each scattering iteration adds a finest
cascade scattering pass and a copy-back pass; one iteration costs more than the old zero default. Turning
it back to zero is a separate useful quality/performance experiment. Removing a cascade usually saves
less than the same fraction of total work because coarse cascades have many fewer spatial probes;
alignment, thin dimensions and far-field injection can change that estimate. Default isotropic volume
shading still samples the pre-averaged lighting once per contributing ray sample; reducing directions
primarily reduces grid update/storage work, with an additional per-ray benefit for nonzero anisotropy.
These are scaling estimates from the loops, not timing claims or a guaranteed ranking on every scene.

## Filtered velocity export: implemented and measured

GasSimulation now maintains three RGBA16F derived textures: color/coverage; density, temperature,
cached speed and vorticity; and signed XYZ velocity (A reserved). Speed-only controls retain their
existing lookup and semantics. `VolumeField.sampleVelocityGPU` is unchanged, but uses a stable sampled
texture node instead of sparse or pressure buffers. Solver transport and GasModule simulation queries
still use their original simulation fields.

Simulation export and late visual export share a three-target writer. It reuses the center velocity
already read for the speed channel; transient visual velocity is exported without changing persistent
solver velocity. Clearing includes velocity, so released/nonresident bricks do not leave stale flow.
The third texture follows the same preparation, staged capacity swap, retirement and reset as the other
two. Memory/peak allocation estimates count it. There is no extra export dispatch; the cost is another
texture write/clear and allocation. Texture-boundary weighting preserves zero-valued outside corners,
and valid-region/backing-size uniforms keep sampling aligned during delayed texture growth.

### Matched export + render A/B

Internal runner: `node scripts/benchmark/internal/volume-velocity.mjs <output>`.
The default isolates the volume path by hiding secondary-system draw objects; scene geometry and
lighting remain. `--full-scene` retains secondary draws, including fire's heat-distortion sprites.
Each preset advances 60 fixed 1/60 updates, then remains frozen. Both modes use identical particles,
fields, bounds, pressure state, camera, mask settings (stretch 0.25), 800x600 drawing buffer and full
render scale. The reference uses the previous sparse cell-centered sampler and two-target export;
the replacement uses the velocity texture and three-target export. Both perform one dense clear,
one simulation export and one late visual export per measured sample, then draw. Source gathering and
the solver are excluded, not assumed to become faster. Results are 24 samples after 20 warmup draws
per mode/view, with fresh per-pass timestamp descriptors from the existing `passTimer` helper.
Each sample had three export compute passes and three render passes in the isolated capture.

Median milliseconds below are independently measured stage medians and paired total medians;
**do not add the stage medians** to reconstruct the total. The total is the union of that sample's
actual pass intervals. These short local observations are not sustained-FPS guarantees.

| Case | Export: buffer → texture | Render: buffer → texture | Paired total: buffer → texture |
| --- | ---: | ---: | ---: |
| Fire / outside | 0.805 → 0.112 | 2.092 → 1.135 | 2.959 → 1.711 |
| Fire / inside | 0.591 → 0.821 | 5.391 → 4.440 | 7.895 → 5.203 |
| Smoke / outside | 0.077 → 0.076 | 2.404 → 1.758 | 2.506 → 1.835 |
| Smoke / inside | 0.080 → 0.088 | 4.513 → 3.076 | 4.592 → 3.177 |

Smoke's paired total fell about 27% outside and 31% inside; its export stayed near 0.08 ms while
rendering became cheaper. Fire's isolated paired medians also fell, but its export intervals were
more variable; the apparently cheaper outside export is not evidence that writing three textures
is inherently faster than writing two. A supplementary full-scene fire capture was bimodal (roughly
2–10 ms paired samples outside), with a worse outside paired median despite cheaper render-only
median. That capture does **not** establish a general full-fire-demo FPS win. Keep refraction/copy
cost and scheduling variation separate from the isolated velocity result rather than concealing it.

Captured logical grids were 32x56x40 for fire and 48x56x48 for smoke, with 0.125-unit cells. Backing
textures were 32x72x48 and 48x72x48, so the added velocity allocation was 0.84375 MiB and 1.265625 MiB.
Total derived-texture storage rises from 16 to 24 bytes per backing texel (+50%); the simulation's
resident field storage is unchanged. Larger domains can make this cost substantial: one additional
128³ velocity texture is 16 MiB, and 256³ is 128 MiB, excluding driver overhead and staged overlap.

PNG comparisons of the same outside/inside views had mean absolute RGBA differences of 0.00012–0.00515
on the 0–255 channel scale; captures were inspected. Signed velocity and filtering are now half precision
in the render export; the solver remains Float32. Matching linear test fields interpolate exactly.
The deterministic GPU lifecycle fixture additionally verifies cross-brick/missing/outside samples,
transient-only velocity, retained sampler bindings after directory/texture replacement, disposed old
textures, released-cell clearing and clear/reset. Smoke/fire staged coarsening/refinement still pass.

Rejected measurements: Three's aggregate timestamp descriptor aliasing made the initial multi-dispatch
aggregate capture unsuitable for this comparison. GPU-canvas readback after presentation, and then
compositing decoded transparent PNGs without clearing the 2D comparison canvas, also produced spurious
image errors. The runner now copies PNGs before query readback and decodes onto a cleared canvas;
reported differences were checked against the saved PNGs. No simulation fix was inferred from those
measurement artifacts.

Raw isolated data/images: `/tmp/rzmps-velocity-texture-isolated-ab/`; supplementary full-scene data:
`/tmp/rzmps-velocity-texture-final-ab/`. The internal runner preserves both modes for future repeats.

## Camera-inside volume cost

A frozen 800x600 camera sweep (90 simulation updates before capture, 12 warmed GPU render samples per
view, cell size 0.125, 256 maximum steps and two samples/voxel) found the increase starts *before*
entering the box. Smoke medians: distant 4.64 ms, near outside 12.13 ms, near inside 14.27 ms, center
9.02 ms. Fire: about 3.49, 9.87, 12.01 and 8.67 ms. Proxy coverage was already 90.5% in the distant view
and 100% in the closer views: the main change is how many rays encounter occupied/dense gas rather
than skip empty bricks or stop against the floor. No extra inside-only pass was found; switching
proxy face culling alone does not explain the sustained drop. Simulation was not advanced between views.

Existing `downsample: 2` reduced the centered inside-view render time to about 4.03 ms for smoke and
2.97 ms for fire. It launches roughly one quarter as many rays and reconstructs against scene depth;
this is the immediate tuning option, with some screen-detail loss. Dynamic resolution's default
16.7 ms target is a render budget, not a total simulation-plus-render frame budget, so it need not
reduce resolution when total FPS drops below 60. A tighter target can be selected independently.

Both raymarch backends now advance past exactly zero-opacity samples before evaluating lighting or
secondary shadow rays. This removes wasted shading in vacuum/masked holes without changing the
sample lattice, density, jitter or opacity integration. A transparent-leading-slab regression verifies
that fixed and adaptive marching still reach later gas and agree, alongside existing inside-camera,
scene-depth and reduced-resolution tests. This small correction does not remove the expected cost
of a screen-filling volume; no new sustained-FPS claim is made from the frozen-view experiment.

## Earlier render-velocity tier-change regression (fixed)

Reproduced with `quality-transition-live.test.mjs`: smoke failed during a forced tier change with
`createBindGroup ... GPUBufferBinding ... buffer ... Required member is undefined`. The volume's
velocity callback compiled the pressure solver's staggered-face sampler into the fragment shader.
It retained that solver's face buffers/directory after quality adoption retired them; ordinary volume
texture/version updates did not rebuild those captured bindings. This is a confirmed tier-transition
failure, separate from previously unreproduced long-run viewport freezes.

The first correction sampled the already-present cell-centered velocity buffer; the texture path above
now supersedes it. Two read-only binding
views (velocity and page directory) plus runtime layout uniforms survive directory/capacity/brick-size
changes. No new backing storage, velocity copy or compute dispatch is added. Brick-interior samples
need one page lookup and eight vector reads, versus three staggered interpolations (24 face samples,
with sparse face-owner lookups) per ray point. Single-source volumes reuse their gathered density
instead of fetching it again just to weight velocity. Pressure/transport retain their staggered sampler.
Prepared program clones do not share or retarget the live render-sampler views during background work.

Targeted tests cover linear interpolation inside/across bricks, sparse/outside zeros, a retained compiled
sampler after disposing the original directory and replacing brick size/capacity, and smoke/fire
coarsening/refinement with the same volume material and sampler callback. The replacement-sampler test
requires zero new compute pipelines after rebind; real plume tests continue for 180 further frames.

A controlled frozen-state A/B on checkerboard at 800x600, one-second-old plumes, stretch 0.25,
12 warmed render timestamp samples per mode (medians, milliseconds; includes all render passes):

| Preset | Stretch disabled | Old pressure-face sampler | Rebound cell-centered sampler |
| --- | ---: | ---: | ---: |
| Fire | 1.851 | 2.732 | 2.575 |
| Smoke | 3.424 | 5.623 | 5.074 |

The measured render reduction is about 6%/10%; the incremental stretch overhead falls about 18%/25%.
These are short fixed-state GPU timings, not sustained-FPS guarantees. They include masking, lighting,
compositing and any change in ray termination from the reconstructed flow; they are not isolated
memory-fetch timers or a separate benchmark of temperature curves. Remaining cost includes eight
buffer reads for trilinear velocity per sampled mask point; existing grid storage is not automatically
a hardware-filtered texture. That earlier correction did not introduce an additional texture export; the current path does, as measured above.
The first direct-buffer draft was slower; explicit coordinate/address temporaries, avoiding dynamic
integer modulo, and the one-page interior path were necessary. Settings and simulation state remained
fixed within each A/B. Snapshots/images and raw timings are in the internal velocity-sampler diagnostic.

## Why temperature modifiers are still cheaper than velocity stretching

The density lookup already returns density plus density-premultiplied temperature, speed and vorticity.
After normalization, temperature modifiers reuse those values. Scalar/range modifiers need uniform
arithmetic, and function curves read two uniform-table entries and interpolate. Noise strength,
contrast and frequency modifiers do not request another spatial neighborhood or evaluate another
noise field. CPU synchronization can still resample function tables; this is distinct from ray cost.

Velocity direction cannot be recovered from speed magnitude. The **previous** render path fetched eight
Float32 velocity entries from sparse storage, resolved page addresses and performed software trilinear
interpolation. The **current** path instead adds one filtered RGBA16F 3D texture instruction, then
normalizes/projects the result to stretch the same procedural noise coordinates. Hardware still reads
neighboring texels internally; velocity is not free, but its addressing/filtering is handled by texture
hardware rather than shader-managed sparse reconstruction. Temperature adds no new spatial lookup at all.
Single-source volumes also reuse their gathered density; multiple fields/children can add weight reads.
A zero local mask stretch skips its velocity lookup, unless another render callback explicitly reads it.

All four parameter channels are retained, so speed-only modifiers do not fetch velocity and preserve
interpolated speed magnitude. `length(interpolatedVelocity)` would differ: opposite neighboring vectors
can cancel although their speeds are nonzero. The new texture does not silently change that behavior.
The full vector cannot fit into the already occupied parameter channels. WebGPU has no native signed
RGB16F storage texture, so the portable layout uses three RGBA16F textures rather than two RGB16F
textures plus color. See [WebGPU format capabilities](https://www.w3.org/TR/webgpu/#texture-format-caps).
The third texture is allocated/exported even when a given renderer does not use stretching; optional
on-demand export is a future optimization, not part of this pass.

Verified implementation references:
[export and sampling](../../packages/rzmps/src/modules/GasSimulation.ts),
[volume sampling and modifiers](../../packages/rzmps/src/rendering/renderers/VolumeRenderer.ts),
[previous buffer reference](../../packages/rzmps/src/spatial/structures/gpu/sparseVolumeSampling.utils.ts),
[uniform parameter curves](../../packages/rzmps/src/values/evaluateDynamicGPU.ts).

## Quality-transition adoption

The prepared destination was being discarded when the live plume changed rectangle dimensions during
compilation. Dimensions are runtime metadata; the prepared directory can cover the latest rectangle
without constructing another transport bundle. Adoption now updates that metadata when directory
capacity is compatible and retains the prepared pressure/directory objects.

Transport preparation owns an isolated snapshot of graph state against the final destination directory
and persistent field/storage nodes. It does not inherit live caches or rebuild the live particle index.
Both scalar ping-pong identities, velocity transport, source gathering, export and transient visual
refresh are collected and compiled before readiness. The adopted owner/programs remain referenced by
the live caches; they are not discarded prototype resources. Replaced programs retire behind the existing
queue/completion fences, and cancellation disposes candidate-owned programs.

Particle-directory generations caused unnecessary invalidation in two places. Gas graphs now key on
particle binding generation rather than bounds generations. ParticleSpatialGrid build programs retain
identity across runtime quality edits; actual storage replacement and structural edits still invalidate
their programs. Source-index bounds/quality update existing runtime bindings. This is a cache correction,
not a sparse allocator/domain redesign.

Forced transition submission dropped from approximately **289–320 ms / 64–66 new compute pipelines** to
approximately **12 ms / 15 pipelines** before the final particle-index cache correction. The remaining
15 were traced to ten particle/source indexing programs, remap support, two boundary programs and two
guard prediction programs. The final regression separately asserts transport/source/visual cache
retention and absence of directory-build pipeline creation at adoption. Final smoke coarsening/refinement submission measured **6.9 / 6.3 ms** and fire **7.8 / 7.0 ms**,
with **five** new pipelines per transition: remap support, two boundary programs and two guard programs.
There were **zero** new transport/source/export or particle-directory build programs. The normal suite's
quality lifecycle measured 5.4 ms submission and the same five pipelines. Boundary/guard work is now
distinguished from transport/source/export work; this is not a claim that adoption is free.

Structural grid edits before prepare are also synchronized before resident reservation. Otherwise a
pressure projection created for old brick dimensions could be paired with new capacity storage.

## Sustained work: separate measurements

The shared timestamp instrumentation now labels:

- Occupied support marking and occupied support/maxima reduction.
- Guard maximum/histogram processing and the receiver ring.
- Source/request generation, counting and reset.
- Active-list compaction, ordered admission/release, source masks and directory/layout work.
- Lighting injection, coarse angular transfer, propagation and isotropic/scattering work.
- Renderer occupancy compute, scene raymarch/raster work and reduced-resolution reconstruction scopes.

Compute stage results use interval unions. They can still overlap **between** categories, so stage
medians must not be added. Scene raster work includes other scene objects. Full-resolution raymarch
and scene draws sharing a pass cannot be isolated by pass timestamps; reduced-resolution nested
raymarch passes are labelled separately from the outer scene/reconstruction pass. There is no separate
LightingGrid occupancy/topology GPU kernel: layout work is CPU metadata/resource work; optical-depth
sampling is part of injection. Those are reported as such rather than inventing GPU categories.

The final stress capture's post-30-second median labelled GPU times were:

| Scope | GPU time |
| --- | ---: |
| Lighting injection | 2.46 ms |
| Lighting propagation | 0.66 ms |
| Coarse angular transfer | 0.47 ms |
| Occupied support marking | 0.78 ms |
| Occupied support/maxima reduction | 0.028 ms |
| Guard support | 0.10 ms |
| Active-list compaction | 0.30 ms |
| Ordered admission/release | 0.16 ms |

These are independently sampled medians over a changing scene mix, not one additive frame breakdown.
There is no evidence here justifying a broader admission/allocator rewrite.

## Bounded lighting optimization

The measured propagation cost repeated an angular sum over every coarse direction at every fine probe.
Angular transfer is linear and commutes with trilinear spatial interpolation. The implementation now
projects coarse directional radiance once at coarse probes, then samples the projected field once for
each fine probe/bin. Requested probe spacing, direction counts, intervals and update cadence stay intact.
Topology, program and texture-node identities remain stable when only light values change.

A controlled moving-light test compares the factored implementation against an unfactored reference
using identical 8-unit bounds, 0.25-unit probes, 12/24/48 directions and eight interval samples.
Median measured lighting GPU time was **5.55 ms → 3.21 ms**; maximum sampled radiance difference was
**0.00195**, consistent with the extra half-float rounding. The reference is maintained in the test fixture.
This is not a promise of the same speedup on every GPU/scene.

Projection intermediates are included in lighting storage estimates. Packed-layout overflow still
coarsens effective spacing instead of throwing; requested spacing returns as domains shrink.
No speculative memory cap or quality reduction was added. Dense valid layouts can still use substantial
memory; an actual allocation/device failure is required before selecting a new memory policy.

## Other long-run viewport freeze: earlier capture did not reproduce it

The earlier aggressive reproduction used Volumetric Smoke / Color Lights at a 1000×750 viewport, DPR 2,
automatic quality, adaptive resolution, camera repositioning and repeated scene switches through
Moving Colliders, Color Lights and Checkerboard.

- Runtime: **120.35 seconds**, **5,500 successful renders**, **eight scene switches**.
- Cell widths: 0.125 and 0.25. Adaptive render scales: 1.0, 0.9, 0.8, 0.7, 0.6 and 0.5.
- No browser exception, uncaptured WebGPU error, device-loss event or persistent viewport freeze.
- Final heartbeat/render/update ages: 6.5 / 10.1 / 82.6 ms; the viewport remained responsive.
- Median frame intervals by successive 30-second windows: 16.7 / 17.7 / 17.3 / 19.5 ms.
- Reduced-resolution target count stayed at **two or fewer**; peak target attachments ~69.6 MB.
- Tracked live allocation delta ended near 794 MB and peaked near 853 MB. Lighting storage peaked
  near 187 MB. These estimates exclude pre-instrumentation allocations, canvas and driver overhead;
  they are **not total VRAM** and do not establish OOM.

That earlier long-run freeze remains **unreproduced**, with diagnostics preserved for future captures.
The subsequently reproduced tier-change render-velocity binding failure is described separately above;
this older stress result does not establish that later regressions were absent or fixed.
Do not conflate it with the following recoverable stalls:

- Scene switches generated 64–86 ms long tasks in several cases.
- Entering Moving Colliders generated approximately 178 ms and 227 ms long tasks, consistent with
  first-use collider/scene resource work. These are scene-switch costs, not evidence of a device freeze.
- Startup recorded a 60 ms long task in this post-start instrumentation window; full preparation
  timings are measured separately by the lifecycle benchmark.

Raw stress data: `/tmp/gas-milestone-stress.json` and streamed `.jsonl` checkpoints. The internal runner
records an independent RAF heartbeat, last successful render/update ages, quality stage, exceptions,
device errors/loss, live/peak allocation deltas and created/destroyed resources. It serializes only new
samples, avoiding the artificial periodic stalls caused by the earlier full-history checkpoint code.

## Normal benchmark coverage

The default/full benchmark selection now includes eight stable GPU-only cases. `suite=gas` runs only
these cases; the short PR selection remains unchanged:

1. Volumetric Smoke steady state.
2. Volumetric Fire steady state.
3. Finer, pressure-heavy gas with pressure diagnostics enabled.
4. Lighting-heavy plume with increased physical probe coverage.
5. Preparation/startup lifecycle.
6. Prepared quality-transition lifecycle.
7. Exact 128→256 resident-capacity lifecycle.
8. Ten-second sustained smoke measurement.

Steady measurements begin after warmup. Lifecycle preparation/adoption/growth is measured separately
before the ordinary frame window. Results include CPU submission, GPU execution, fenced wall intervals,
pipeline creation and workload context: subdivisions/cell width, bounds, active/resident pages/cells,
particle count, solver diagnostics, lighting levels/probes/effective spacing/storage and render scale.
Packed-plane and pressure storage retention is checked across capacity growth; migration/rebind phases
come from the staged allocator. The validated 128→256 case retained the fields exactly, created zero
pipelines, and measured ~11.1 ms fenced wall time, with ~1.1 ms allocation and ~0.1 ms swap CPU time.
Sub-millisecond migration submission and storage preparation rounded to zero in that capture; GPU/queue
execution is not inferred from that timer resolution. The focused fixtures retain stronger deterministic field-transfer tests.

No benchmark asserts machine-specific FPS. Unavailable timestamp data remains null rather than using
CPU wait as GPU execution. Detailed per-pass and long-run logs remain internal instead of appearing in
ordinary PR output. See `scripts/benchmark/README.md` for measurement conventions.

## Demo and light API completion

LightRenderer directly accepts dynamic brightness, color, distance, decay and optional power.
Values use particle normalized lifetime and ID seed. Power is an alternative to brightness using
Three.js's `power / (4 * PI)` conversion; optional particle alpha is applied afterwards.
Reused light slots reevaluate every option; inactive slots emit nothing. The GUI and exported presets
use the flat renderer API and display either brightness or power as the emission control.

Volumetric Fire uses `brightness: time => 4 * (1 - time) ** 2`; the remainder of its simulation is unchanged.
The exported source retains that function. Gas Flow is replaced by Moving Colliders: a sphere, rotating
box, sweeping cylinder, polyhedron and floor. The four moving shapes follow different three-dimensional
paths with translation and rotation, through ordinary automatically discovered scene meshes.

Smoke and fire tests found the same five meshes in fluid and ordinary collision discovery. All four
moving transforms matched their collected collider transforms, fields stayed finite and rigid motion
created **zero new compute pipelines** after warmup. Captured smoke/fire images were inspected; the
visible plume/flame interacts with the moving objects without obvious page gaps. Transform/membership
checks supplement these finite captures; they do not exhaustively prove all future collision behavior.

## Remaining maintenance scope

Recoverable first-use scene/collider-baking stalls remain measured follow-up work. The older long-run
freeze is unreproduced, not declared fixed; the later tier-change render binding regression is fixed. Gas-specific lifecycle regressions now have normal benchmarks
and focused tests. FLIP's long-run particle-count slowdown is outside this gas milestone.

## Remaining rendering diagnostics

The initial standalone preview capture reported render-pass-already-ended errors. The direct preset
and corrected tier-transition fixtures pass, but that separate preview-path limitation was not rerun
for this documentation update. The current 12-sample stretch A/B above supersedes the initial
four-sample draft; the draft's timings should not be used as the current baseline.

The anisotropy audit found the existing sign already correct. Direction names/comments now explicitly
identify bins as directions toward light and camera rays as directions into the volume. Both are
negated for the physical HG dot product. Opposite camera views at g=-0.8, 0, +0.8 match
[Blender's documented convention](https://docs.blender.org/manual/en/2.81/render/materials/components/volume.html):
negative favors the light-facing view, positive favors the opposite view, zero is isotropic. Changing g
and camera side triggered zero LightingGrid updates in the static fixture. No propagation/attenuation
change was needed. This compares conventions; Blender itself was not rendered locally.

The phase fixture isolates lighting with depth clipping and empty-space skipping disabled because it
contains no occluders. An initial opposite-view capture showed off-center speckles with those paths
active; the phase direction was unchanged. The existing depth/upsampling regression still passes, but
that observation is not declared fixed. If it recurs in normal scenes, capture a full-frame depth/skipping
A/B separately rather than attributing it to HG or changing jitter/resolution to hide it.

### Earlier individually timestamped stages (not a current baseline)

This earlier, pre-sampler-correction full-suite smoke/fire capture used fixed 1/60 updates, 3+3 subdivisions, 0.125-unit cells,
16 iterative pressure sweeps, full render scale and the harness's 800×150 drawing buffer. Smoke ended
at 205 active/resident pages (104,960 cells), 67 particles and 32,704 lighting probes (~7.95 MB).
Fire ended at 149 pages (76,288 cells), 45 particles and 21,024 probes (~5.11 MB). Probe spacing was
0.25 in both. These are **two timestamped samples each** over evolving states, not a controlled
before/after comparison or a reliable long-run distribution. Keep the stronger controlled lighting
comparison above separate. Independently measured medians and overlapping scopes must not be summed.

| Stage, GPU interval ms | Smoke | Fire |
| --- | ---: | ---: |
| Particle source spatial index | 0.070 | 2.100 |
| Boundary cells | 0.146 | 0.187 |
| Velocity advection / forces | 0.270 | 4.454 |
| Velocity source injection | 0.062 | 1.890 |
| Curl | 0.035 | 3.058 |
| Vorticity confinement | 0.027 | 2.311 |
| Pressure topology | 0.328 | 1.981 |
| Pressure sweeps | 1.826 | 10.736 |
| Scalar transport / diffusion / decay | 0.116 | 3.359 |
| Scalar source injection | 0.796 | 2.479 |
| Solid scalar constraints | 0.070 | 0.016 |
| Volume field export | 2.942 | 1.054 |
| Occupied support marking | 0.064 | 0.263 |
| Support/maxima reduction | 0.104 | 2.461 |
| Guard support | 1.903 | 0.027 |
| Admission/release | 0.153 | 0.030 |
| Active-list compaction | 0.106 | 0.149 |
| Lighting injection | 3.144 | 0.125 |
| Lighting angular transfer | 5.009 | 0.132 |
| Lighting propagation | 1.834 | 7.174 |
| Renderer occupancy | 0.906 | 1.557 |

The union totals were 24.04 / 44.34 ms compute and 3.10 / 10.12 ms exclusive render for smoke/fire,
with CPU submission medians 1.6 / 2.6 ms. Even-sample upper medians of separate categories need not
add to total medians. Small-N variation is substantial; these measurements identify follow-up scopes,
not proof of a new performance regression or a reason to change admission. Pressure/transport, source
masks, export/occupancy and lighting remain possible workload-dependent costs. A same-state, adequately
sampled comparison is required before choosing an optimization. Raw capture:
`/tmp/volume-appearance-stages.json`.

### Reported acceleration after a quality decrease: open

The reported faster cell-crossing/runaway growth after coarsening has not been reproduced by the fixed-tier
stage benchmarks. No speculative solver correction was made. Current tracing identifies these candidates:

1. **Time budget versus wall time.** FluidSimulation computes `safeDt = cfl * h / measuredSpeed`
   (falling back to the configured maximum speed). ParticleSystem bounds catch-up by
   `maxFluidSubsteps * step`. When a lagging fine tier exhausts that budget, some time is skipped;
   doubling h can double the permitted physical catch-up. That can look like acceleration relative to
   wall time even if velocity units are correct. At cfl=2, speed=20 and four steps, h=0.125 permits
   ~0.05 s catch-up versus ~0.10 s at h=0.25 for a sufficiently large requested interval. This is
   conditional on hitting the cap, not proof that normal 60 Hz updates accelerate. The current fixed
   fixtures measured speed about 2.75–3.02 at h=0.125, where the 1/60 interval is below the CFL limit;
   these captures therefore do not demonstrate catch-up clipping.
2. **Source support changes.** Gas source radius has a minimum of one cell width. Coarsening expands
   that minimum in world units; the sampled source kernel may then inject over a larger physical volume.
   Measure integrated source density/heat and support at fixed particle state before deciding whether
   normalization or a different sub-cell source model is appropriate.
3. **Resolution-dependent confinement and convergence.** Vorticity confinement intentionally includes
   the Fedkiw cell-width factor; derivatives and fixed pressure-sweep budgets also change discretization
   error with h. They can alter motion without an explicit world-velocity scale error.

Existing transfer tests preserve conservative scalars and MAC face averages. Pressure starts are cleared
for a replacement projection, so stale ordinal pressure alone is not established as the cause.
Backtracing uses `worldPosition - worldVelocity * dt` before converting to cell coordinates. Next isolate
a source-free translation pulse across one 2× coarsening and compare world-space displacement per summed
executed solver time, wall time, incoming/outgoing momentum, integrated mass/heat and post-projection
divergence. Then repeat with sources/forces enabled individually. Record requested/executed/skipped time
and asynchronous maximum-speed observations alongside the quality event to distinguish these candidates.
