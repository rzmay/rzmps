# Gas Stage Profiling And Adaptive Ray Marching

Measured 2026-10-28 on Chromium native WebGPU, Apple Metal 3. This supplements
[the grid performance diagnostic](fluid-performance-diagnostic.md); it does not
replace its fixed-side-16 measurements with a different workload silently.

Subsequent visual-tuning changes: opacity-aware stepping now defaults to off.
Noise strength is a nonnegative exponent, with separate `noiseContrast` defaulting
to one. The Gas Volume demo now uses 3/4 subdivisions, 300 particles/second and
mask strength 2 / contrast 1.5. The performance tables below retain their original
55-particle/second workload and former mask/default semantics as historical results.

Active/new-brick indirect dispatch and grouped clears are now implemented too.
Gas's default resident budget is 512 rather than 32; the demo uses that default.
See the [current dispatch measurements](fluid-performance-diagnostic.md#active-dispatch-and-grouped-clears-implemented)
for matched-input results. The stage tables below predate this scheduling pass.

## Source-Gather Corrective Pass

Implemented after the initial diagnostic below. No pressure, transport, source
weighting, renderer quality or preset tuning was changed in this pass.

- Source support is marked in conservative four-cell tiles using the actual
  particle radius (with the existing one-cell minimum). A bitset is appended to
  existing sparse metadata; gather consumers need no additional storage binding.
  Marking filters live particles and module tags, but does not rely on density
  occupancy or assume that transient alpha/scale can only decrease.
- Persistent masks are generated while marking particle allocation requests.
  Render-time masks are rebuilt from the current render-buffer positions and
  scales after transient processing. They are separate in time, not incorrectly
  reused across movement or transient changes. Source masks never disable pressure,
  transport or retained gas, and do not replace the gas allocation policy.
- Simulation density, heat and color now share one particle-neighbor traversal.
  Velocity remains a separate pass because it precedes pressure and scalar transport.
- Transient density, heat and color share one traversal too. Their two vec4 output
  fields now share one allocation/binding, keeping the combined shader within the
  standard eight-storage-buffer limit. Storage bytes are unchanged. Skipped active
  cells explicitly clear transient contributions to prevent trails from dead or
  moved sources. Inactive pages remain unreadable through the sparse page table.

Five source queries per cell become three, and most cells containing only advected
gas skip all source queries. At 128 axis resolution the two bitset copies add
approximately 8 KiB total. The transient mask requires three small dispatches;
the allocation stage adds one metadata copy dispatch. No new public API or GUI
controls were needed, and renderer children/volume ray marching are unchanged.

### Corrective Measurements

The final isolated run is `/tmp/rzmps-gas-source-gathers-final/metrics.json`.
The same script, scene, warmup, automatic side-eight bounds and iteration counts
were used. The script now rejects page navigation/hot reload during measurement.
Resident/source counts vary slightly between runs; this is not a bitwise-identical
snapshot comparison. All final checkpoints report zero brick overflow.

| Stage / Configuration | Before ms | After ms |
| --- | ---: | ---: |
| 3/4, 800x600: complete GPU update | 19.04 | 4.06 |
| Velocity source gather | 3.36 | 0.48 |
| Density / heat + color gathers combined | 6.74 | 0.48 |
| Transient gathers + export | 6.73 | 0.31 |
| New transient source mask | -- | 0.012 |
| Pressure projection | 1.33 | 1.22 |
| 3/4, 1600x900: complete GPU update | 19.10 | 4.01 |
| 2/5, 800x600: complete GPU update | 41.71 | 9.66 |
| 2/4, 800x600: complete GPU update | 2.26 | 3.73 |

The targeted seven-subdivision 3/4 case is about 4.7 times faster in this run;
source-related dispatch work drops from about 16.8 ms to 1.3 ms. An earlier run
measured 4.13 ms for the same update, supporting the large improvement. Pressure
is now the largest individual simulation stage rather than particle sourcing.
For 2/5, pressure costs about 4.6 ms and fresh-slot inspection/clears about 1.25 ms;
larger bricks still carry a significantly higher cost than 3/4.

The low-resolution 2/4 result did not improve in the clean final run. It had 11
active bricks versus the original nine, and pressure/transport also became more
expensive despite no changes to those algorithms. Another repeat ranged down to
1.57 ms, but contained a development-server reload and is not the final benchmark.
Do not advertise an across-the-board speedup at low resolution. A matched-state
low-resolution comparison is needed to separate source-mask branch overhead from
changing plume occupancy/history and run-to-run scheduling/clock effects. The
current evidence supports the seven-subdivision optimization, not a guaranteed
speedup for every scene or grid quality.

No ray-march improvement is attributed to this pass. Render settings and code are
unchanged; timings in the raw matrix still depend on the evolving plume snapshot.

### Corrective Verification

`tests/visual/gas-source-gathers.test.mjs` compares the optimized masks against
exhaustive gathering on the same controlled inputs, using both advection methods.
Density/heat, color, velocity and transient output buffers match exactly in the
recorded test. Inputs include overlapping splats, nonuniform radii, grid-edge
support, tag exclusion and transient scale/color/alpha changes. The test marks
26 of 4096 source tiles and runs with an eight-storage-buffer device limit.
After source death the source mask and visual contributions clear while gas remains.

Existing source lifetime/alpha/collision tests, sparse pressure/reclamation/reuse
tests and the 60-second gas numerical suite pass. The full library build, type
checks and runtime tests pass. These equivalence checks preserve the existing
query candidate semantics; this pass does not redesign particle-grid queries,
transient support allocation, source-to-cell scattering or physical emission rules.

The bounded source-mask/combined-gather pass is complete. Further candidate-list
caching, source scatter, indirect dispatch and pressure optimization remain separate
decisions. The following sections retain the initial diagnostic and its measured
baseline for comparison.

## Method

Run `node tests/visual/gas-stage-profile.mjs /tmp/rzmps-gas-stages`.
The recorded run is `/tmp/rzmps-gas-stages-verified/metrics.json`, with screenshots
alongside it. The script uses the actual Gas Volume preset and Gas Flow scene,
including colliders, automatic bounds, 16 pressure iterations and SemiLagrangian
transport. It warms up 120 fixed updates, measures 12 updates, then 12 individually
timestamped updates with per-stage attribution. Rendering uses the resulting
frozen field, three warm renders and 12 measured renders for each configuration.
The render matrix varies 80/160 samples, mask off/on, and each optimization off/on.
Ray spacing is held at 0.25 cell; the 80-sample cap is relevant in this scene.
GPU mask strength is 0.7 with one octave when enabled; two-octave simulation
turbulence remains enabled in every case.

Three's compute timestamp queries attribute dispatch costs without putting a
CPU/GPU fence between each solver stage. Stage wrappers are diagnostic-only and
are removed before rendering. CPU submission and queue-fenced update time are
also measured without these attribution wrappers. Dispatch durations are GPU
work measurements, not perfectly exclusive critical-path slices; their medians
should not be added to predict exact frame latency.

Depth snapshots interrupt/resume rendering. Native GPU timestamp intervals for
these passes overlap, so adding their durations double-counts time. The script
records each actual pass with distinct queries and reports the GPU span from
the first start to the last end, including inter-pass gaps. Raw intervals and
queue-fenced render times are retained for auditing. Background-only GPU spans
are approximately 0.06 ms at 800x600 and 0.13 ms at 1600x900.

The automatic domain settled at side eight, with approximately 40 live source
particles in 256 allocated slots. The 3/4 cases use a 64-brick budget to avoid
overflow: the default 32-brick pilot run dropped 3-4 requested bricks. Production
defaults were not changed. All final sampled cases report zero overflow. Exact
source/brick counts differ slightly because concurrent GPU insertion/allocation
and runtime readback scheduling are not bitwise reproducible.

## Simulation Results

GPU durations in milliseconds. All cases have the same physical domain size and
pressure iteration count, but different cell sizes and active-cell populations.
The seven-subdivision configurations are not equally expensive sparse layouts.

| Stage | 2/4, 64 Axis | 3/4, 128 Axis | 2/5, 128 Axis |
| --- | ---: | ---: | ---: |
| Whole update, GPU | 2.26 | 19.04 | 41.71 |
| Whole update, queue-fenced | 3.00 | 19.40 | 41.90 |
| CPU submission | 0.80 | 0.80 | 0.80 |
| Velocity source gather | 0.19 | 3.36 | 5.63 |
| Density / temperature source gather | 0.19 | 3.43 | 5.74 |
| Color source gather | 0.19 | 3.31 | 5.67 |
| Transient visual gathers + export | 0.39 | 6.73 | 11.30 |
| Pressure projection, 36 dispatches | 0.57 | 1.33 | 4.31 |
| Velocity advection / buoyancy / turbulence | 0.07 | 0.20 | 0.41 |
| Scalar transport / diffusion / dissipation | 0.07 | 0.19 | 0.35 |
| Vorticity | 0.03 | 0.06 | 0.21 |
| Particle hash, ten build dispatches | 0.03 | 0.03 | 0.04 |
| Sparse activation / allocation | 0.04 | 0.12 | 0.13 |
| New-brick clear dispatches | 0.18 | 0.34 | 1.25 |
| Grid collider sampling | 0.02 | 0.03 | 0.10 |
| Dense export texture clear | 0.03 | 0.27 | 0.24 |
| Simulation texture export | 0.02 | 0.03 | 0.10 |
| Field maxima reduction | 0.02 | 0.03 | 0.10 |
| Active / resident-budget bricks | 9 / 32 | 36 / 64 | 8 / 32 |

The transient visual stage is three dispatches: density/heat gather, color gather,
and export. It is compute work during particle-system updates, not ray marching.
The small steady-state collider number does not include initial geometry baking.
The clearing kernels inspect fresh-slot flags every frame; their measured cost
does not mean every resident cell is actually cleared every frame.

At 3/4, source-related gathers account for about 16.8 ms of dispatch time. Pressure,
animated force noise, allocation and ray marching are not the primary bottleneck.
At 2/5, larger bricks activate more cells for the same narrow plume and make most
field passes more expensive. Prefer another brick subdivision over another cell
subdivision when the resident-brick budget permits it.

Why this is slower than the earlier 2.72 ms seven-subdivision result: that test
used a fixed side-16 domain, 12 active bricks and no Gas Flow collider scene. The
current side-eight domain has finer physical cells, more active bricks, and more
neighbor cells within each particle's fixed world-space splat radius. Both are
real measurements, but they do not measure the same active workload.

## Rendering Results

Frozen 3/4 field, no procedural density mask. GPU render spans in milliseconds:

| Viewport / Max Samples | Neither | Depth Only | Opacity Only | Both |
| --- | ---: | ---: | ---: | ---: |
| 800x600 / 80 | 1.51 | 1.47 | 1.49 | 1.46 |
| 800x600 / 160 | 2.74 | 2.59 | 2.70 | 2.60 |
| 1600x900 / 80 | 3.60 | 3.47 | 3.57 | 3.47 |
| 1600x900 / 160 | 7.21 | 6.69 | 6.89 | 6.37 |

With the animated erosion mask at 800x600 / 80, neither/both measured 1.49/1.40 ms.
At 1600x900 / 80 the corresponding values were 3.60/3.65 ms: no reliable gain.
Mask erosion changes accumulated opacity and therefore the termination/step-growth
pattern; mask-on timing is not a pure additive noise ALU measurement. Frequency,
density, ray divergence and GPU clock changes matter. This plume does not promise
a large opacity-adaptation win; many rays never accumulate enough opacity to
qualify. Keep the off switches for quality/performance comparisons.

At the larger viewport and 160 samples, rendering becomes meaningful, but the
roughly 19 ms update still dominates. At 800x600 / 80, removing ray marching
entirely could save only about 1.5 ms; source-gather work offers much more headroom.

## Implemented Controls

Scene-depth clipping defaults to enabled on `VolumeRenderer`; opacity-aware
stepping now defaults to disabled. Numeric controls are
uniform-backed and editable at runtime; both demo GUIs and serialization include
them. No render-resolution reduction, temporal reconstruction, or upsampling was
implemented.

| Option | Default | Meaning |
| --- | --- | --- |
| `adaptiveStepping` | `false` | Enable opacity-dependent step growth. |
| `adaptiveStepThreshold` | `0.5` | Accumulated opacity at which growth starts, in [0, 1). |
| `adaptiveStepFactor` | `4` | Maximum multiple of the base step, at least one. |
| `transmittanceThreshold` | `0.01` | Stop below this remaining transmittance; zero disables early termination. |
| `sceneDepthClipping` | `true` | Clip the ray interval against opaque depth; requires `depthTest`. |
| `sceneDepthBias` | `0.001` | Nonnegative view-space distance before the opaque surface. |
| `stepSizeMultiplier` | `1` | Existing cell-relative base sample spacing. |
| `steps` | `100` | Existing maximum sample budget, clamped to 512. |

Scene-depth clipping uses WebGPURenderer's viewport-depth snapshot and supports
perspective/orthographic views, reversed depth and camera-inside views. Disabling
it retains per-sample depth rejection for comparison, not drawing through walls.
Disabling `depthTest` explicitly disables both clipping and depth rejection.
Legacy WebGLRenderer gains opacity-aware stepping, but still has only its existing
hardware proxy-depth test, not the viewport-depth snapshot path. GPU gas already
requires WebGPURenderer. Transparent surfaces without depth writes and overlapping
transparent-volume ordering remain separate compositing limitations.

## Opacity Contract

Density, density mapping and `opacity` remain the canonical per-reference-cell
optical properties. The renderer computes each segment's opacity as
`1 - pow(1 - mappedCellOpacity, segmentLength / referenceCellSize)`.
This correction existed for uniform steps; it now uses the actual variable
segment length, including the last partial segment before geometry or box exit.
Uniform media therefore have the same opacity for coarse, fine and adaptive steps.

The step factor grows smoothly from one to its configured maximum as accumulated
opacity goes from the start threshold toward one. Geometry clipping preserves
the pre-clipping base spacing instead of packing the full sample budget into the
shorter interval. Sampling uses segment midpoints, or a stable per-ray fractional
jitter inside each segment. The sample budget still covers the full original
interval by increasing base spacing when necessary, rather than truncating fog.

Coarser sampling of nonuniform density/color/noise can still differ because it
misses features, not because density is renormalized. Early termination deliberately
approximates the remaining contribution; its threshold is not a strict HDR color
error bound. Tests set it to zero when verifying opacity equivalence. No simulation
field is modified by these controls.

## API References

Unreal's [heterogeneous volume controls][unreal] expose a volume-relative Step
Factor and maximum sample count. Its [cloud controls][clouds] expose a stop-tracing
transmittance threshold. These are the primary precedents for the compact controls
here; they are not a claim of exact Niagara/Unreal renderer parity.

[Unity HDRP fog][unity] separates screen/depth-grid quality from simulation; its
[cloud quality controls][unity-clouds] expose primary/light sample budgets.
This pass does not copy Unity's reconstruction/reprojection system.
[Blender's biased volume marcher][blender] exposes voxel-relative step rate and
maximum steps. The new adaptive opacity-start and maximum-growth pair are local
heuristic controls, not purported identical settings in all three products.

## Initial Recommended Scope

Focus on source gathers before changing the pressure solver or adding upsampling:

1. Mark source-active bricks/cells separately from gas-active bricks. Skip source
   queries where no tagged live particle's support can reach the cell. Preserve
   all advected gas and transient alpha/scale/color semantics; never use this mask
   to turn off physical transport or pressure in already emitted gas.
2. Combine compatible source targets or cache reusable weights/indices. Current
   velocity, density/temperature, color and transient visual passes repeatedly
   traverse the same particle hash. Respect WebGPU's eight-storage-buffer minimum;
   combining every target into one kernel without packing is not automatically
   viable. Start with density/color pairs and measure binding/work tradeoffs.
3. Consider a coarser source-query grid or source-to-cell scatter only if the mask
   and combined gathers leave a bottleneck. Atomic float accumulation, stable
   color/temperature weighting and tagged/transient inputs require care.
4. Skip fresh-brick clearing dispatches when GPU-visible allocation state proves
   there were no fresh pages, without introducing a synchronous CPU readback.

End point: improve measured source-stage times at 3/4 without changing the gas
model or losing color, temperature, alpha, retained gas or collider correctness.
Keep the current ray controls and defer more renderer changes until that result
is measured. This diagnostic pass did not implement these solver optimizations.

## Verification

Uniform opacity tests cover 4/17/160 samples and growth factors 1/4/12 on both
renderers. Native WebGPU tests cover opaque surfaces before/inside/behind gas,
orthographic switching, reversed depth, oblique views and camera-inside clipping.
Existing volume tests cover providers/tags, children, filtering, animated noise,
unchanged fields and mobile visibility. Library types, invalid-option tests,
GUI control visibility and generated API references are checked separately.

[unreal]: https://dev.epicgames.com/documentation/unreal-engine/heterogeneous-volumes-in-unreal-engine
[clouds]: https://dev.epicgames.com/documentation/unreal-engine/volumetric-cloud-component-properties-in-unreal-engine
[unity]: https://docs.unity3d.com/Packages/com.unity.render-pipelines.high-definition@14.0/manual/Override-Fog.html
[unity-clouds]: https://docs.unity3d.com/Packages/com.unity.render-pipelines.high-definition@14.0/manual/Override-Volumetric-Clouds.html
[blender]: https://docs.blender.org/manual/en/5.0/render/cycles/render_settings/volumes.html
