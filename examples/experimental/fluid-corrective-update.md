# Fluid corrective update

This updates the November 10 infrastructure review. The module/renderer architecture,
particle BVH collision, mesh discovery, and sparse brick addressing remain in place.
Spray remains secondary particles; this pass adds no foam, bubbles, temporal reconstruction,
brick-skipping raymarcher, or adaptive gas-domain resizing.

## Pressure

`pressureIterations` still controls a fixed solve by default. Optional
`pressureMinIterations`, `pressureMaxIterations`, and `pressureTolerance` allow convergence
checks. `pressureWarmStart` defaults to true. New gas bricks and newly active FLIP regions
start with zero pressure; compatible retained cells keep their previous solution.
Reallocated grids and changed bounds invalidate that solution. Migrated pools preserve it.

`pressureDiagnostics: true`, or an active benchmark collection, exposes `pressureStats`:
maximum absolute Poisson residual, maximum/mean absolute divergence before and after
projection, executed fine sweeps, maximum velocity, and non-finite sample count. Readbacks contain reductions,
not complete fields. They are asynchronous observations of a completed solve.
Tolerance checks gate subsequent fine sweeps on the GPU; CPU submission still schedules
the configured maximum. This avoids a CPU/GPU synchronization for every sweep.

The optional multigrid path performs one V-cycle correction between fine smoothing sweeps.

The supplied spec assumed an existing multigrid solver. There was none in this checkout.
`SparsePressureMultigrid` is therefore the single shared implementation, driven by a
field adapter in `FluidPressureProjection`, rather than a second gas-specific solver.
Gas defaults to `pressureSolver: 'Iterative'`. Multigrid remains opt-in: the controlled
fixtures converge, but an evolving sparse plume still develops excessive velocity.
Those fixtures alone did not justify making multigrid the production default.
Residuals are evaluated in separate dispatches before restriction; this avoids invalid
conditional stencil evaluation in generated shaders. The V-cycle restricts residuals and
face coefficients, smooths coarse corrections,
prolongates them, and finishes with fine smoothing. Coarse occupancy is derived from
fine pages through `SparseVolumeGrid`; a dense global hierarchy is never allocated.

A 16-cubed sinusoidal-velocity regression, at 16 fine sweeps, reduced maximum divergence
from approximately 3.003 to 2.679 with the iterative path, and to 0.316 with one V-cycle plus fine smoothing.
The 32-cubed curved-obstacle case reduced maximum divergence from 14.711 to 5.628
(iterative) or 0.800 (multigrid). A sparse diagonal-wall case reduced it from 3.106 to
0.284 or 0.0387 respectively. Every comparison reported zero non-finite samples.
This establishes convergence on those controlled cases, not a universal speedup. Cold
pipeline construction must not be compared with warm GPU execution time.

## Boundaries

Cell occupancy remains conservative: any positive occupancy sample marks the binary
collision/debug field solid. Pressure and gas grid classification separately use
fractional face openings and estimated fluid volume. Four face samples and eight cell
samples approximate coverage. An occupied center missed by all quadrature samples
falls back to a blocked cell. This is an approximation, not exact triangle clipping
or a guarantee that arbitrarily thin geometry is resolved at any grid quality.

Divergence uses `open * fluidVelocity + (1 - open) * solidVelocity`; the pressure
Laplacian and projection use the same face weights. Swept particle BVH containment is
unchanged. Narrow curved passages can still be limited by particle diameter, field
sampling, and the baked geometry resolution.

Rigid wall velocities come from previous/current transforms in simulation coordinates.
They clear on the next stationary step. Geometry motion reuses existing baked fields;
deforming meshes still need their normal field refresh and do not yet supply a full
per-vertex deformation velocity field. The controlled moving-wall test measures 7.5
units/second for a 0.125-unit displacement over 1/60 second, then zero when stationary.

Boundary baking on FLIP and gas uses active bricks. Cached static geometry also refreshes new
bricks, without rebaking the whole domain. `readBoundaryDiagnostics(renderer)` returns
boundary-cell, partially open-face, and fully blocked-face counts; benchmark collection
samples those automatically. The corrective fixture provides numerical boundary cases and solid-fraction/face-openness
visualizations (red is blocked, green is open).

## Allocation, preparation, and timesteps

Gas now distinguishes `initialBrickCapacity` (default 64, limited by the logical grid and configured maximum) from `maxBrickCapacity`
(default 512, also controlled by the existing `maxActiveBricks` setting). Capacity grows
geometrically and does not shrink. GPU copies preserve page identities, both scalar
ping-pong fields, color, velocity, pressure, occupancy, boundary data, and scratch fields.
Transient render fields are migrated; MacCormack predictor buffers are rebuilt because
they are overwritten before use. Texture objects remain stable across pool growth.
The regression verifies field preservation while growing from 4 to 64 bricks.

Demand readback is asynchronous: a sudden activation can exceed current capacity for
an update before growth is applied. Overflow is counted, never assigned over another
resident brick. Choose a larger initial capacity when a first-frame burst must fit
immediately. Capacity, active bricks, allocated/peak bytes, migration time, and growth
count are benchmark metrics. Byte estimates include field buffers, pressure hierarchy,
addressing, and volume textures, but not driver overhead or material allocations.

`await system.prepare(renderer)` calls the generic `Module.prepareResources` hook
without ordinary prepare/update callbacks, emission, age changes, collision events, or
time advancement. Both fluid modules upload initial field buffers and bake collision data; gas also
initializes its volume textures. Both asynchronously compile their pressure pipelines. Normal updates remain lazy-compatible. This is not a guarantee that every
particle-count-dependent gather, collision, surface, or material pipeline is compiled;
those can still incur a first-use cost. Preparation requires an initialized renderer.
The 16-cubed fixture measured roughly 6 ms construction, 832 ms preparation, 16 ms first
render, and 211 ms first-update submission (295 ms fenced). The unprepared 128-cubed demo
still took 838 ms first-update submission versus about 1–3 ms warm submission. Remaining
first-use kernels are a real startup limitation; these measurements do not establish that
all startup stalls have been eliminated.

`adaptiveTimestep`, `cfl` (default 2), and `maxFluidSubsteps` (default 4) request a smaller
step from the existing system loop. Emission, transfer, integration, and collision then
share one clock, rather than nesting an independent FLIP integrator. Field-speed
reductions are asynchronous; the configured velocity ceiling is the initial fallback.
The demo awaits preparation before updating GPU-only modules. Clear/restart invalidates
pressure and persistent gas state when particle storage is replaced, without confusing
ordinary buffer capacity growth with a reset.

The system enforces `maxFluidSubsteps` across the complete incoming interval through
`Module.getSimulationSubstepLimit()`. It discards unrecoverable history using the existing
time-skipping path instead of enlarging a CFL step or queuing unlimited solver work.
Other modules retain an unlimited step count unless they request a limit. Asynchronous
velocity observations still make CFL an estimate, not an unconditional stability guarantee.

## Transfer and reconstruction investigations

FLIP benchmark metrics now include transfer energy before/after, marker count, PIC/FLIP
weights, and velocity variance. The corrective fixture uses a rotating particle block
with zero gravity, zero external force, zero pressure sweeps, no separation, no
colliders, no surface renderer, and no spray. Compare PIC weights 0 and 0.05 there before
attributing the complete teapot's appearance to transfer damping. In the controlled
one-transfer case, pure FLIP retained energy to floating-point precision; a 0.05 PIC
weight reduced energy from 1.80000 to 1.77770 (about 1.24%). That quantifies damping,
without establishing its share of the teapot's wall/spout artifacts. APIC has not been
introduced: a transfer-only measurement cannot establish that it is the dominant
remaining error in a moving, partly resolved vessel.

`surface-quality-review.mjs` independently reconstructs the same fixed colored markers
with different voxel sizes, kernel radii, iso thresholds, and smoothing. It records
triangle counts, enclosed volume, normal variation, boundary/non-manifold edges, stage
submission times, fenced reconstruction/render time, and screenshots. Diagnostic mesh
readback and CPU topology analysis are excluded from that timed interval. Field reconstruction,
extraction, smoothing, and mesh update register through the existing benchmark API.
The controlled results distinguish three effects: finer voxels reduce normal variation,
but expose real gaps in sparse particle support; smoothing improves normals without filling
those gaps; a 25% larger kernel closes gaps but inflates the reconstructed volume by about
60%. The finest test also found one non-manifold edge, with zero open boundary edges.
This is a Surface Nets topology ambiguity, not evidence of a fluid-grid brick seam.
A topology-aware extraction change remains a separate follow-up; no arbitrary global
kernel increase or new reconstruction algorithm is applied to conceal it.

Stage CPU spans measure submission, not GPU work. Renderer-wide GPU timestamps remain
renderer-scoped; the focused pressure harness uses real dispatch timestamps and records
`pressureSolveGPU` through `Benchmarks.record`. The pressure comparison covers 16/32-cubed
grids, 16/64 active bricks, 1/32/128 source
particles, and empty/curved/diagonal obstacle cases. GPU dispatch timestamps were
unavailable in this local run; `gpuMs` is explicitly null. Fenced wall time is recorded
separately and is not presented as GPU time. Broader production workloads are still
needed before claiming an overall performance improvement or choosing more aggressive defaults.

## Browser performance regression and corrective follow-up

The initial fixed-step fixtures missed the real-time catch-up path. After a startup stall,
one displayed gas update executed 144 solver steps and another spent 5.90 seconds in CPU
submission. Compilation and pool-growth delays then generated more catch-up work. The
baseline took 92.5 seconds for 302 sampled frames, with a median update interval of 125 ms.

The follow-up fixes are:

- Enforce the four-step fluid budget in the system loop, including subsystem requests.
- Reduce diagnostics and CFL velocity cooperatively in 64-lane workgroups, then reduce
  partial results hierarchically. Sparse reductions visit active cells through indirect
  dispatch instead of scanning the entire dense FLIP backing field.
- Cache unchanged gas collision fields; refresh newly activated bricks and moving geometry.
- Start gas with up to 64 bricks to avoid repeated early pool growth. Growth remains possible
  and can still require a kernel rebuild; it is not free.
- Capture each packed buffer's original stride when creating field views. Pool migration
  previously addressed the old wall-velocity and visual-color halves with the new stride.
- Serialize demo scene replacement against resource preparation and pause updates while
  either is pending. An asynchronously loaded teapot otherwise disposed fields during compilation.
- Restore iterative gas projection by default. In the evolving-domain multigrid run, velocity
  reached its safety cap and capacity grew; that numerical issue remains a separate follow-up.

On the local native-WebGPU browser, the final default gas run completed 600 sampled frames
with no pool growth, no non-finite field samples, and a maximum CPU update submission of
1.8 ms (roughly 0.9–1.0 ms warm). The median update interval was 16.7 ms. After pausing,
a GPU queue fence took 8.4 ms; this is backlog wall time, not an isolated GPU stage timing.
Maximum observed field velocity stayed near 1.9. Projection reduced mean absolute divergence
from 0.136 to 0.00144 in the final diagnostic. A sustained teapot run reached 11,112 live
particles over 1,500 sampled frames; late CPU submission stayed near 1.7–1.8 ms rather than
continually increasing. These are local measurements, not portable frame-rate guarantees.

The sampled window begins after demo initialization. It demonstrates bounded steady-state
work, not a complete cold-start benchmark. Shader compilation and population-dependent
first-use pipelines remain startup costs. The final screenshot no longer shows the earlier
fully filled/empty brick blocks, but does not establish that every camera or plume is artifact-free.

No liquid pressure, PIC weighting, or viscosity tuning changed in this performance follow-up.
Spout discharge and wall chunkiness still require a controlled solver/boundary investigation.
PIC damping is dimensionless and must not be relabeled as centipoise. A physical viscosity
control requires a viscosity diffusion model, density, and a defined scene-unit scale.

## Reproduce

Build the library first, then run the following native WebGPU checks separately:

```sh
npm test --workspace @rzmps/rzmps
node scripts/tests/preview/fluids/corrective.test.mjs
node scripts/tests/preview/fluids/reduction.test.mjs
RUNTIME_FRAMES=600 node scripts/tests/preview/fluids/runtime-performance.mjs
node scripts/tests/preview/fluids/pressure-comparison.mjs
node scripts/tests/preview/fluids/surface-quality-review.mjs
node scripts/tests/preview/fluids/infrastructure-review.mjs
node scripts/tests/preview/fluids/moving-wall.test.mjs
```

Metrics/screenshots default to `/tmp/rzmps-fluid-corrective`, `/tmp/rzmps-pressure-comparison`,
and `/tmp/rzmps-surface-quality`. An output-directory argument overrides those paths. The GUI exposes behavior/performance controls and keeps diagnostic storage hidden.
