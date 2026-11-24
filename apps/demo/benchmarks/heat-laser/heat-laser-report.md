# Heat Laser development and performance report

## Current focused milestone — 2026-11-24

This is a development report. The example guide contains usage/configuration explanations only.
The old moving-scene **31.9 ms GPU / 18.8 ms scene-render** observation below is historical: a fresh
baseline on the current checkout measured **9.00 / 4.03 ms**. It was not reproduced as current cost.
No emission rates, particle/splat sizes, simulation/render quality, pressure accuracy, or storage caps
were reduced in this milestone. Existing source caching remains intact.

### Frozen rendering attribution

`apps/demo/tests/heat-laser-render-attribution.browser.test.mjs` advances the automatic sphere/beam
for six fixed simulation seconds, then freezes fields, particles and scene transforms. At 1280×800 it
warms four draws and timestamps eight draws for each individual exclusion. The final runner locks
screen resolution at full quality so dynamic resolution cannot invalidate the comparison. It verifies
unchanged particle/page counts, density version, cell width, steps and samples-per-voxel across A/Bs.

| Final frozen draw, one category excluded | Median GPU interval union |
| --- | ---: |
| Everything enabled | 3.115 ms |
| Volume disabled | 0.630 ms |
| Grouped/dynamic scene lights disabled | 3.115 ms |
| Burn/scorch decals disabled | 2.931 ms |
| Trails disabled | 3.142 ms |
| Ordinary receiver meshes disabled | 3.221 ms |
| Everything enabled, repeat | 3.160 ms |

Volume drawing dominates. Differences are not additive: hiding receivers changes opaque occlusion,
and disabling lights can change both material work and volume radiance. The small trail/light differences
are within this run's noise. The initial pre-change exclusion measured 3.215 ms enabled versus 0.677 ms
without volume and led to the same conclusion. One intermediate adaptive-resolution A/B changed scale
from 0.9 to 0.8 and failed its invariant; those timings are rejected.

The renderer now caches occupancy until the nearest coarse boundary across **all** provider/copy
transforms; it no longer reads the same occupancy texel on every fine stratum. Density at/below the
configured remap floor skips appearance/noise work when no custom render module can restore it.
Color textures are not fetched for zero-density contributions. Jitter, sample lattice, distance-corrected
opacity, simulation fields and rendering quality are preserved. Custom render modules still run on empty
samples because they may create visible gas.

An alternating reference/cached comparison on the **same final frozen fields** measured **3.620 ms
reference versus 3.086 ms optimized**, about **14.7% less GPU time**. The reference disables interval
caching and the early appearance exit; both variants retain the safe zero-density color-fetch guard.
`volume-occupancy-interval.browser.test.mjs` compares whole images against that reference with jitter,
vacuum, rotated children and camera-inside views: all four comparisons were pixel-identical.

### Grouped lights

The same particle bank was used for 1, 2, 4, 8 and 16 real lights. Measured grouping/selection compute
medians were **0.437, 0.414, 0.398, 0.387 and 0.396 ms**, respectively, after warmup. These are compute
interval unions, not scene-render times; CPU readback and count-specific graph creation are separate.
The demo keeps its existing **two** real lights. Their frozen draw cost is negligible here, and lowering
that count further would not address the dominant path. No broad grouping algorithm rewrite is justified.

### Cold preparation versus steady throughput

Pressure initialization had different input/output bindings from the prepared solve, and diagnostic
reductions were not compiled unless diagnostics were already enabled. Preparation now captures both
initialization bindings plus diagnostic/velocity reduction variants without executing a solver step.
Grouped CPU-readback renderers now capture their existing spatial/selection graphs without readback or
dispatch. This happens **after** generic particle bindings are finalized; preparing sooner caused first-use
identity/version invalidation and discarded the warmed grouping. Occupancy reduction is also precompiled.
Existing gas preparation already covers physical source/transport and separate render-source families.

| Normal real-RAF, automatic motion, 16 seconds | Fresh baseline | Final acceptance |
| --- | ---: | ---: |
| Presented frames | 895 | 949 |
| Frame interval median / p95 / p99 | 16.7 / 17.1 / 18.1 ms | 16.7 / 17.3 / 17.5 ms |
| Maximum frame interval | 596.2 ms | 97.9 ms |
| Intervals above 90 ms | 2 | 1 |
| First update CPU submission | 556.4 ms | 63.5 ms |
| New compute pipelines in first update | 68 | 5 |
| Warm total GPU union median / p95 | 9.002 / 11.127 ms | 8.287 / 11.275 ms |
| Warm scene-render union median / p95 | 4.028 / 5.974 ms | 3.466 / 4.805 ms |
| Registration-to-first CPU birth maximum | 412.9 ms | 185.6 ms |

Final explicit preparation took **1,742 ms**, before starting the RAF measurement. This moves known
graph construction/compilation into asynchronous `prepare()`; it does not remove that work or pause
the simulation clock. The original first update included **379.8 ms pressure setup and 101.8 ms light
submission**. Neither exceeds the runner's 5 ms reporting threshold in final acceptance. Remaining
first-use work includes five unnamed compute pipelines and CPU collision-tree creation during
initial dynamic classification; the second update spent 73.1 ms CPU, including about 17 ms in the beam's
collision backend. The remaining 97.9 ms startup interval is not a steady-state pressure/light stall.

Whole-run results are workload observations, not exact physical-state replays: final peak particle/page/
burn counts were **617 / 1,659 / 123**, versus **610 / 1,407 / 112** before. Decal-anchor correction and
nondeterministic trajectories affect the fields. The matched frozen shader comparison is stronger
evidence for the render optimization than interpreting the live medians as an exact speedup ratio.
An intermediate 844-frame run had 33.6 ms p95 and 36.6 ms p95 GPU time as its plume grew; the final
run did not reproduce that tail. Longer/heavier plumes remain a scaling limitation, not a proven eliminated
issue. Two cold fixture attempts timed out around Vite dependency reloads; the runner now uses the
existing 504-aware fixture opener. It retries only proven outdated-dependency responses, not GPU failures.

### Stage costs and next bottleneck

Warm final timestamp scopes exclude the first 60 frames. CPU submission, GPU unions and fenced
completion are distinct; overlapping scope medians must **not** be added.

| Final GPU scope | Median | p95 |
| --- | ---: | ---: |
| Scene render-pass union | 3.466 ms | 4.805 ms |
| Physical source gather + velocity initializer | 1.323 ms | 1.676 ms |
| Scalar initializer traversal | 0.533 ms | 0.688 ms |
| Render-source reconstruction | 1.096 ms | 1.323 ms |
| Pressure solve | 0.686 ms | 1.070 ms |
| Pressure topology / pressure sweeps | 0.081 / 0.346 ms | 0.124 / 0.491 ms |
| Brick activation | 0.604 ms | 0.659 ms |
| Volume renderer submission-associated compute | 0.668 ms | 0.692 ms |
| Grouped-light submission-associated compute | 0.375 ms | 0.456 ms |
| Source spatial index | 0.024 ms | 0.056 ms |
| Velocity / scalar injection after cached gathering | 0.009 / 0.009 ms | 0.012 / 0.017 ms |

Pressure kernels already dispatch indirectly over compact active pages/cells; guard-only logical bricks
allocate no cells. Admission has separate demand-priority passes, and helper occupancy is dispatched
only when its visualization is enabled. These measured sub-millisecond paths do not justify changing
pressure accuracy or rebuilding admission. Removing receiver pages from pressure solely because their
density is zero can break velocity projection/transport, so no such pruning was applied without a new
stage-support correctness proof.

Remaining source cost is mostly gathering and custom initializer iteration, not injection or source-index
construction. Mixed-radius splat candidate pruning remains a useful next compute investigation. Reusing
initializer results across velocity/scalar stages is not generally safe: callbacks may read their stage's
gas snapshot. Render-time gathering remains separate for transient position, alpha, color and scale.
No public initializer-purity flag or extra source cache was introduced speculatively.

**Next dominant throughput target:** volume drawing remains the largest single render cost; source
gathering/reconstruction is the largest identified simulation-side family. Cold CPU collision preparation
and unnamed first-use graphs are separate remaining hitch targets.

### Decal anchoring and settled debris

The performance capture used the former distance-factor implementation. A follow-up API correction
replaces that factor with `overlap`: `FromPoints(from, to, maxStretch, overlap)` now fits a centered bridge
across the points, preserving crosswise width and a minimum of the original length. Burns use 1.25
overlap (25% extra fitted length), scorches 1.1. Both ends extend equally; `maxStretch` still caps the
final length multiplier. Translation is folded into existing geometry UVs, adding no shader bindings.
These performance measurements were not rerun for this small reconstruction change.
The preset anchors to the most recent accepted
burn mark, so rejected minimum-distance collisions cannot collapse this gap. Reheating chooses the
contacted existing mark as the anchor until a new mark is accepted. Its receiver-local emission frame
follows moving objects; removed marks, scene/receiver changes and contact gaps reset the bridge.
Both decal layers retain randomized pre-warp rotation and their existing stretch caps.

Debris also had independent initial angular velocity in `[-5, 5]`, which persists even when
`RotationBySpeed` adds zero below its threshold. The preset now initializes angular velocity to zero.
The generic module retains its existing clamped-value/additive semantics. Focused CPU/GPU-callback
tests cover zero and nonzero lower endpoints and independent initial angular channels.

Artifacts: `/tmp/heat-milestone-before.json`, `/tmp/heat-milestone-acceptance.json`,
`/tmp/heat-milestone-final-attribution.json`. The real-RAF runner records actual first-use pipeline labels,
source-birth latency and independent queue-completion probes. Frozen runners fence only outside their
steady timing windows; real-RAF acceptance does not block each frame on GPU completion.

Validation includes the package build, focused lint, 39 unit checks across preparation/light/rotation/
warp/sweep behavior, the five cold-preparation checks rerun after the final CPU-only guard, and native
volume occupancy/emissive and Heat Laser lifecycle/drawing checks. The child-rotation regression also
passes on WebGL and WebGPU after correcting its fixture to give intentionally replaced source geometry
a new field identity: production domain growth deliberately keeps its old rotation pivot. The first
version of that fixture changed geometry around an existing cached pivot and sampled outside the
rotated source; that assertion failure was not a change to the WebGL renderer. WebGL cannot run the
gas-based Heat Laser preset itself; its preview validation uses native WebGPU.

## Historical results

All measurements and configuration comparisons below are historical, migrated from the developer
example documentation. They describe their respective earlier runs, not the current Heat Laser
milestone. References to “current”, “now”, “new”, “final” or “corrected” in these archived notes are
relative to those runs. Preserve their workload and timing caveats when comparing later results.
Use the current milestone section above for release-facing measurements.

Developer usage: [Heat Laser example](../../../docs/examples/heatLaser.md).
Test paths below are relative to the repository root; `/tmp` paths refer to local run artifacts.

### Intermediate sweep stretch diagnosis and focused validation (superseded)

The contact listener previously replaced both `FromPoints` endpoints on every beam-particle collision.
At 600 beam particles/s, consecutive events can describe nearly identical contacts, including repeated
hits during one simulation step. `FromPoints` scales tangential displacement directly; raising its
factor from 4 to 32 cannot stretch a zero displacement and barely changes very small displacements.

The preset now snapshots the previous step's final contact once during controller preparation and
updates only the endpoint during collision delivery. Both decal layers retain `FromPoints` and their
existing factors/caps. Receiver changes, gaps over 0.1 seconds, scene resets and disabling the beam
restart contact tracking. A stationary contact settles to zero displacement on the next step. This
remains displacement-based, so its magnitude depends on simulation-step duration; it is not normalized
into velocity and does not use ray incidence.

`node --test apps/demo/tests/heat-laser-sweep.test.mjs` exercises the preset tracker and source warp
implementation without a browser. It checks repeated identical and nearby collisions, advancing the
baseline, stronger deformation at factor 32 than 4, stationary contact, reverse sweep, interruption
resets and independence from placement-ray incidence. No current milestone performance or visual
results are asserted here. The final decal-anchored approach and validation are described above.

### Historical configuration comparison

Continuous emission uses 15 particles per second per burn. Source strength is `0.1` and velocity
coupling is `0.018`: emission is one quarter of the previous rate while each contribution carries four
times the density and velocity coupling. This preserves expected integrated contribution, not identical
individual voxel samples. Particle lifetime, temperature, mass, alpha and the shrinking `0.3` splat scale
remain unchanged. Increasing splat size would cover more cells and can increase gathering work.

The earlier usage notes described a 16-second burn lifetime. The current factory uses
`controls.baseLifetime` with an 8-second default; current usage values belong in the example docs.

### Historical emission and real frame pacing


Spark and debris rates use visual hit-selection ratios of 0.08 and 0.025 respectively; these are
independent of storage capacity. Small population ceilings were replaced with generous headroom: 4,096 beam particles, 16,384 sparks, 8,192 fragments, 65,536 gas-emitting
particles and 16,384 decals per layer. These are finite storage ceilings, not recommended performance
budgets; the measured workload stays below them. Decal spacing still prevents duplicate placement at
a stationary hit, with source-bound reheat bursts providing the extra flame emission there. The burst emitter emits one
particle per hit at twice the ordinary emission temperature, with a shorter 0.35-second particle lifetime.

CPU source callbacks stage birth packets for the GPU allocator. Dead GPU slots can be reused without
waiting for the CPU mirror. GPU occupancy uses GPU used slots divided by GPU allocated slots, excluding
CPU beam/spark/debris populations. The source-relative emission clock remains independent of resetting
a decal's cooling age.

CPU-only emitter event subscriptions do not require a shared native-GPU event journal. The old detection
created one simply because `onEvent` existed. With large demo ceilings this reserved a 184 MB binding,
exceeding WebGPU's default 128 MB storage-binding limit. Detection now checks whether an emitter can
actually consume native GPU events from its selected producers. The CPU-driven reheat event follows
its existing direct/staged path without that unused journal. Genuine native GPU journals also bound
their double-buffered, power-of-two reservation to the device's actual storage-binding limit.

### Historical baseline before particle-capacity preparation

`apps/demo/tests/heat-laser-frame-pacing.browser.test.mjs` uses 1280 × 800 rendering, normal
`system.update()` wall-clock timing and catch-up, and 16 seconds of real RAF operation. It includes
cold first-use work, stationary contact, sweeping and return visits. It does not wait for GPU timing
readbacks or queue fences inside the animation loop. Per-frame records include slow CPU scopes,
pipeline creation, populations, resident bricks and source birth latency. Full results are written to
`/tmp/heat-laser-frame-pacing.json`.

A local native-WebGPU run with the current spark/debris ratios and reheat bursts recorded 639 frames
and zero GPU validation errors:

| Measurement | Median | p95 | p99 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Real RAF frame interval | 17.0 ms | 48.3 ms | 251.5 ms | 1,008.1 ms |
| Decal registration → CPU birth packet | 3.4 ms | 5.2 ms | 7.6 ms | 7.6 ms |
| Submitted-work completion callback lag | 25.4 ms | 194.5 ms | 340.1 ms | 340.1 ms |

Seven frames exceeded 90 ms. These tails remain a real performance problem even though the median
interval is near 60 FPS. CPU birth-packet latency does not measure first visible gas; queued work and
browser scheduling can delay presentation after emission has already been submitted.

### Historical lower-emission baseline before source caching

The continuous gas rate is **15 particles/s per burn**, and each reheat event emits **one particle**.
`sourceStrength: 0.1` and `velocitySourceStrength: 0.018` compensate for the fourfold reduction in both
emission paths. Lifetimes, particle mass, temperature, shrinking size, cooling and noise settings are
unchanged. Expected density, transported heat/color and velocity coupling are preserved statistically;
temporal/spatial sampling is less dense, so individual cells need not match the previous run exactly.

The same 16-second 1280 × 800 real-RAF fixture measured:

| Measurement | Higher emission | Current configuration |
| --- | ---: | ---: |
| Peak live gas-emitter particles | 5,029 | 1,214 |
| Final burn decals | 101 | 104 |
| Largest reserved particle capacity | 8,192 | 2,048 |
| Median frame interval | 17.1 ms | 16.6 ms |
| p95 frame interval | 43.5 ms | 18.7 ms |
| p99 frame interval | 248.9 ms | 50.1 ms |
| Median total GPU interval union | 18.42 ms | 10.18 ms |
| p95 total GPU interval union | 31.73 ms | 13.30 ms |
| Median velocity-source injection | 3.09 ms | 0.89 ms |
| Median scalar-source injection | 3.10 ms | 0.89 ms |
| Median render-source reconstruction | 3.23 ms | 1.00 ms |
| p95 velocity / scalar / render source scopes | 8.07 / 7.71 / 7.55 ms | 1.72 / 1.63 / 1.73 ms |

GPU statistics exclude the first 60 frames. Runs have similar decal populations, but cold work and
nondeterministic trajectories differ; they are not identical field-state replays. Stage medians are
not additive. The lower-emission run still had seven intervals above 90 ms and a 1,069.5 ms maximum,
so cold/setup stalls remain separate from the sustained source-gathering improvement.

Registration-to-CPU-birth latency increased to 18.3 ms median and 49.3 ms maximum in the real-RAF
fixture. With continuous emission at 15/s, its natural scheduling interval is 66.7 ms. This bounded
sampling delay is distinct from multi-second stalls, and existing-source reheat remains event-driven.

Increasing the splat radius is unnecessary for this configuration. The kernel is mass-normalized:
a larger splat redistributes the same contribution over more cells and increases candidate/affected
cell work. Keep the existing `0.3` starting scale and lifetime shrink rather than using radius as a
mass-strength multiplier.

### Historical source cache and initial reserve

The gas subsystem sets `initialCapacity: 4096`, while retaining `maxParticles: 65536`. The initial
reserve prevents repeated early particle-backing changes; it does not emit 4,096 particles or set a
population ceiling. Other systems keep their own initial reserves and global defaults.

Physical deposition now gathers raw mass, heat, contributor count, premultiplied color and momentum
once per solver step. Velocity injection and scalar injection reuse those moments. The velocity-stage
initializer remains fused with gathering, and scalar-stage initializers run again at their original
stage. Their `particles.forEach` queries and current gas-grid queries retain their semantics. Render-time
source reconstruction remains independent so transient alpha, color, scale and position are respected.
All cached moments are overwritten each physical step, including zeroing cells without contributing
sources; cache contents are not carried across simulation steps as authoritative gas state.

The cache reuses a four-plane packed transient workspace, with the first two planes later reused by
visual reconstruction. This adds **32 bytes per resident-capacity cell**, including one sentinel, with
no extra storage binding or public cache controls. Empty logical guard bricks still allocate no cells.
Resident-pool growth migrates every packed plane using runtime strides, and device capacity limits
account for the larger binding. Quality changes/reset rebuild the appropriate cache programs.

A controlled GPU test froze the same 1,596 particles, 4,096 allocated slots, 204 resident pages and
0.125 cell width, then compared the complete physical source pass sequence. Sixteen timestamp samples
per mode measured median interval unions of **8.14 ms direct**, **6.64 ms cached**, and **6.66 ms on a
cached repeat**: approximately 18% less GPU time for those physical source passes. Custom initialization
and actual deposition are included; compilation, simulation advection/pressure and rendering are outside
that isolated comparison. This does not imply an 18% improvement for every scene or whole frame.

The final normal 16-second real-RAF fixture recorded 898 frames, peak gas-emitter population 1,329,
106 final burn decals and **4,096 slots throughout**, with no particle-capacity growth. Frame intervals
were **16.7 ms median, 17.2 ms p95, 17.8 ms p99**, with two intervals above 90 ms and a 598.6 ms maximum.
The warmed total GPU interval union was **10.25 ms median / 13.86 ms p95**. Cold/setup and source visibility
tails remain: this run's first-birth CPU maximum was 424 ms near stalls, despite an 18.9 ms median. It
should not be described as fully hitch-free. A preceding run showed substantially worse live pacing
while the frozen-input comparison remained repeatable, so representative FPS remains workload and
scheduling dependent.

The new `sourceMomentGather` benchmark scope includes raw gathering and velocity-stage initialization;
`scalarSourceInitialization` measures the later initializer traversal. The injection scopes now consume
the cache, so comparing their isolated times with old gather-plus-injection scopes would be misleading.
The frozen-input test compares the union of the complete source sequence instead of summing stage medians.

GPU parity tests compare direct and cached mass/density, temperature, color and velocity with live source
clock/metadata changes and empty input. A resident-growth invariant checks all four workspace planes,
retained pressure/fields, sentinel clearing and zero new compute pipelines for compatible growth.

Remaining source-work improvements include candidate pruning for mixed splat sizes and reducing
initializer traversals where their semantics permit. The existing arbitrary initializer API remains
supported; no renderer/module preparation hooks were added for this cache.

### Historical earlier high-particle latency and slow-frame breakdown

Particle-capacity preparation is limited to particle backing and the existing generic particle programs.
There are no extra module/renderer preparation hooks. `capacityGrowthThreshold` defaults to `1`; it is
editable on the system and preserved by GUI code export. The heat-laser preset retains that default.
The population estimator counts each known live source execution: previously, it predicted only 46
particles for the emitter definitions even with dozens of active burn sources. Observed occupancy and
incoming batches still cover event-driven demand that the static estimate cannot predict.

The dedicated 256 → 512 slot GPU invariant verified exact packed-field retention while the old bank
continued running, stable particle-state identity, unchanged simulation time during adoption, and zero
new pipelines both at adoption and on the first ordinary update. One local fixture measured about
0.2 ms allocation, 35 ms asynchronous preparation, 0.3 ms migration submission and 0.1 ms swap. In the
live workload, preparation ranged from 43–88 ms for early tiers and reached 755 ms on a later, canceled/
restarted preparation. These are distinct from the allocation itself, which stayed at 0.2–0.8 ms.

`heat-laser-latency.browser.test.mjs` now records registration, CPU birth, packet submission, queue
completion, first source-linked GPU-particle observation and nearby gas observation. A 480-frame
fixed-step sweep observed all 72 registered sources, with no CPU birth rejection:

| Since source registration | Median | p95 | Maximum |
| --- | ---: | ---: | ---: |
| CPU birth | 2.5 ms | 3.7 ms | 4.8 ms |
| GPU packet submission | 3.3 ms | 4.4 ms | 5.2 ms |
| Submitted-work completion callback | 5.6 ms | 14.9 ms | 72.7 ms |
| First source-linked GPU particle / nearby gas probe | 54.3 ms | 89.0 ms | 294.8 ms |
| Probe readback completion | 72.0 ms | 106.2 ms | 314.9 ms |

Probes run every six frames; their observation timestamp is not the exact birth time or first displayed
pixel. Nearby gas is also not unique provenance when plumes overlap. Completion includes browser-thread
scheduling and queue delay. This run did not reproduce multi-second source scheduling, and its short
CPU/submission times do not establish that all presentation latency is solved. An earlier 720-frame
trace with the undercounting estimator reached 643 ms submission-completion delay and 848 ms probe
completion. The different durations and nondeterministic workload prevent treating that comparison as
a controlled speedup ratio. Full traces retain per-source submission state and capacity metrics.

The earlier high-particle 16-second real-RAF run recorded 650 frames: **17.1 ms median, 43.5 ms p95, 248.9 ms p99,
601.2 ms maximum**, with seven intervals over 90 ms. This still has unacceptable tails. The following
GPU stage values use 29 timestamp samples after the first 60 frames, at 1280 × 800:

| GPU scope | Median | p95 |
| --- | ---: | ---: |
| Velocity source injection | 3.09 ms | 8.07 ms |
| Scalar source injection | 3.10 ms | 7.71 ms |
| Render-time source reconstruction | 3.23 ms | 7.55 ms |
| Pressure solve scope | 1.00 ms | 1.48 ms |
| Pressure sweeps scope | 0.65 ms | 0.90 ms |
| Brick activation | 0.25 ms | 2.04 ms |
| Source spatial index | 0.03 ms | 0.04 ms |
| Compute interval union | 14.94 ms | 28.19 ms |
| Render-pass interval union | 7.87 ms | 13.73 ms |
| Total GPU interval union | 18.42 ms | 31.73 ms |

Do not sum stage medians or compute/render unions: execution overlaps and samples cover changing work.
The three source passes repeat spatial particle gathering, including source-aware initializer iteration;
they are the main warmed GPU target in this trace, rather than source-index construction or decals.
A future optimization should investigate sharing gathered source moments between these consumers while
preserving transient render-time alpha/color/scale and initialization semantics. No such change is made here.

Ordinary 66–68 ms gaps occurred with unchanged capacities and zero new pipelines; their preceding CPU
updates were around 9–10 ms. They are distinct from allocation/setup and consistent with GPU/queue and
catch-up pressure, but these measurements do not uniquely attribute the entire gap. The cold first
update took about 559 ms CPU, including 385 ms pressure setup and 103 ms light submission. Later
particle-backing changes still rebuilt roughly 80 gas/grouping-dependent pipelines through their
ordinary paths: approximately 123–128 ms gas setup, 23–24 ms render-source setup and 92–94 ms light
submission within roughly 246–254 ms updates. Generic particle preparation does not remove those costs. Gas transport currently includes particle-buffer
version in its broad cache key, so a binding change invalidates more than deposition alone; grouping also
specializes its storage/assignment programs to input capacity. Narrowing those internal dependencies is
a possible follow-up without new public preparation APIs, provided source-index and particle bindings
are kept consistent.

A 50% threshold experiment reserved up to 16,384 slots and worsened live frame pacing (52 ms median,
135 ms p95); that preset override was removed. Preparing earlier alone is not a steady-state GPU
optimization and can increase reservation and work. The default remains 100%, with a corrected estimator.

### Historical decal scaling isolation

`apps/demo/tests/heat-laser-decals.browser.test.mjs` isolates the authored burn/scorch materials in a
particle-free, gas-free system at 1280 × 800. Each layer remains one BatchedMesh. Counts below are
**per layer**, so 2,048 means 4,096 total decals. GPU values are timestamp interval unions, CPU values
are separate update measurements, and neither should be read as live frame rate.

| Layout | Decals per layer | CPU update | CPU: ten reheat queries | GPU render | Hidden-decal GPU baseline |
| --- | ---: | ---: | ---: | ---: | ---: |
| Spread | 128 | 1.0 ms | 0.3 ms | 0.63 ms | 0.19 ms |
| Spread | 512 | 2.3 ms | 1.0 ms | 1.63 ms | 0.46 ms |
| Spread | 2,048 | 8.0 ms | 3.0 ms | 6.61 ms | 0.19 ms |
| Overlapping | 128 | 0.6 ms | 0.1 ms | 0.96 ms | 0.20 ms |
| Overlapping | 512 | 2.0 ms | 0.6 ms | 3.80 ms | 0.18 ms |
| Overlapping | 2,048 | 7.9 ms | 2.3 ms | 17.60 ms | 0.19 ms |

Batching reduces draw submission, not transparent fragment overdraw. Thousands of overlapping layers
are measurably expensive, but this isolated workload does not explain 167 ms frames (6 FPS) by itself.
Updating fades, receiver transforms and registered sources also remains proportional to decal count.

Incremental growth through 257 decals per layer creates two render pipelines at the initial frame and
at instance-capacity boundaries 17, 33, 65, 129 and 257. Render submission at those boundaries measured
8–12 ms after initial setup. Instance-texture replacement requires refreshed bindings; removing that
refresh would reintroduce stale-buffer rendering rather than solve the broader stalls.

Receiver complexity has a different cost. The previous full-mesh Three.js projection scanned every
receiver triangle; creating a burn/scorch pair on a 131,072-triangle plane took 58–98 ms across eight
samples. **That projection measurement is superseded by the limited-selection path.** Dense receivers
now use a shared, cached indirect BVH to gather nearby triangles, then pass that subset to the same
Three.js DecalGeometry projection/clipping implementation.

Repeating the same fixture measured 25.7 ms for the first pair, including BVH construction, then
2.1–3.7 ms for subsequent pairs on the 131,072-triangle receiver. On the 2,048-triangle receiver, the
first pair took 3.9 ms and subsequent pairs 0.2–0.5 ms. The two-triangle direct path stayed at 0–0.7 ms.
These are local eight-sample CPU creation measurements, not live FPS. Rigid receiver movement reuses
the acceleration; marked position edits refit it and topology changes rebuild it. This correction does
not reduce transparent overdraw or fix the separate GPU capacity-transition stalls.
Full isolation results, including incremental growth and receiver complexity, are written to
`/tmp/heat-laser-decals.json`.

### Historical automatic receiver motion

The real-RAF runner also supports `RZMPS_HEAT_LASER_MOVING=1` and an optional
`RZMPS_HEAT_LASER_TRACE` output path. It updates the scene's automatic sphere motion before each
particle-system update, records collision backend scopes and local fluid-collider bake identities,
and uses the same 16-second, 1280 × 800 workload as the stationary runner.

| Automatic-motion frame interval | Before refitting | With refitting |
| --- | ---: | ---: |
| Frames in 16 seconds | 42 | 530 |
| Median | 337.3 ms | 25.7 ms |
| p95 | 806.4 ms | 53.5 ms |
| Maximum | 1,312.4 ms | 654.6 ms |
| Intervals above 90 ms | 41 | 4 |

The dominant regression was repeated **CPU dynamic triangle-octree construction** in the beam,
spark and debris collision backends. Each update cost about 16–28 ms per backend, repeated by up
to four catch-up steps, contributing 200–365 ms CPU updates. Local fluid-collider occupancy textures
retained their identities through motion; this was not repeated GPU BVH or occupancy baking.

`ThreeCollisionBackend` now skips unchanged poses. A common transform of the dynamic geometry
updates its existing triangle vertices and refits tight node bounds bottom-up, retaining the partition
and contact metadata. Independent object motion, geometry/UV edits, material-sidedness changes,
settings changes and explicit invalidation still rebuild. The refit keeps world-space collision queries
and does not approximate capsule radii in nonuniformly scaled local space. Deterministic tests compare
contacts with fresh builds across translation, rotation and scale and check invalidation/provenance.

The corrected run's median CPU system update was 9.1 ms. Across timestamp samples after frame 60,
the total GPU interval union was 31.86 ms median / 39.97 ms p95; the scene render-pass union was
18.78 / 22.75 ms. Light submission-associated compute measured 4.05 / 6.33 ms, physical source
gathering 1.38 / 2.25 ms, scalar initialization 0.53 / 0.68 ms, and render-source reconstruction
1.54 / 3.08 ms. These scopes overlap and their medians must not be added. Changing trajectories,
receiver contact and gas occupancy also mean these live runs are not frozen-state GPU comparisons.

Median frame rate improved from roughly 3 to 39 FPS with automatic motion, but this does not establish
stable 60 FPS. The first corrected update still spent 420 ms in cold pressure-program setup and
109.5 ms in first light submission; cold setup remains distinct from the resolved recurring rebuilds.
The next warmed optimization targets are scene rendering/transparent overdraw and grouped-light
work, followed by active-page pressure/activation work and remaining source traversals. Reducing
receiver triangle density is no longer the first remedy for ordinary rigid-motion stalls.

### Historical transition diagnostics

The older 251–285 ms particle-growth and 416 ms resident-growth observations remain useful historical
correlations. Use the current breakdown above for release-facing claims: storage allocation, asynchronous
preparation, first-use dependent graph setup, ordinary GPU work and presentation/readback latency are
separate costs. Several earlier measurements could not distinguish host scheduling from driver/queue
backpressure and should not be read as proof of a specific GPU allocation failure.

The older 800 × 600 fixed-step, short steady-window results are **superseded for real FPS claims**.
`heat-laser-performance.browser.test.mjs` remains useful for isolated GPU stage and frozen-render A/B
checks, but its timing samples await readbacks and its update clock does not reproduce live catch-up.
Use the real-RAF runner to evaluate future changes against the slow-frame tail, not just steady medians.
