# Fluid Diagnostics

These are development diagnostics, not a claim of renderer or solver parity.
Run the GPU study with `node tests/visual/fluid-study.mjs /tmp/rzmps-fluid-study`.
Run the Blender reference with:

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b -t 2 \
  --python tests/visual/fixtures/blender-smoke.py -- /tmp/rzmps-blender-study
```

Both scripts produce metrics and images. Blender needs access to its graphics
device even for this background CPU bake. Its evaluated domain must be read;
reading `density_grid` on the original modifier crashes Blender 4.4.3.

## FLIP Outliers

After five seconds of the teapot example, move one GPU marker to x=30 with vx=1.
The unbounded domain grows to 128 units after padding and power-of-two rounding.
At 64 cells per axis this changes cell width from 0.25 to 2, coupling previously
independent parts of the liquid through very coarse cells. The hash is sparse;
the fluid solver's velocity and pressure arrays are dense, not sparse bricks.

With `maxBounds: 16` the GPU and solver domains stay at 16 (cell width 0.25).
The escaped marker retains vx=1 and falls ballistically; the cap is not a wall.
The normal 60-second collection test and the injected-outlier test are covered
by `fluid.test.mjs`. This demonstrates the grid-growth failure mechanism, not
proof that every possible long-running instability has been eliminated.

## Corrective Pass Results

The develop merge is resolved, including its shortcut/decal changes and tests.
The options-only managed-grid API is retained without compatibility guards.

### Bounds Ownership

The particle hash could previously expand on the GPU while the Eulerian solver
kept its old bounds until a readback completed, up to 500 ms later. Those passes
would disagree about the world positions represented by their cells. Fluid
modules now own resizing: the hash uses a fixed domain during each update and
readback only queues a change for the next prepare/rebuild. Gas remaps its fields
in that update before advancing them. `automaticPadding` controls domain growth;
`autoShrink` is now honored by the CPU controller. Cubic/power-of-two shape is
retained; those constraints and hash `autoExpand` are not editable fluid controls.

Lifecycle generations discard stale reads after cleanup or a domain change.
GPU tests deliberately request hash expansion, inject an outlier, and check that
hash and solver bounds remain equal both before and after the queued resize.
The 16-unit FLIP cap remains a coarsening mitigation, not an artificial wall.

### Runtime Parameters

Changing `pressureIterations` between odd/even values could leave a cached
projection reading the wrong pressure ping-pong buffer. Changing it to zero
could even apply a previous nonzero pressure solution. Projection is now
invalidated when the effective iteration count changes; a 1/0/4/0 GPU test
verifies that zero iterations leaves the seeded velocity unchanged.

FLIP `picRatio` was compiled into a cached transfer shader. It is now a uniform,
so editing it changes the next simulation update rather than waiting for an
unrelated shader rebuild.

### Transport Accuracy

`GasSimulation.advectionMethod` supports `semiLagrangian` (the unchanged default)
and experimental `macCormack`. The latter uses a forward prediction, reverse
error estimate, and eight-donor limiter, reverting to first order near solids,
domain edges, or steps larger than one cell. It uses three lazily allocated
scratch fields, an additional 12 MiB at resolution 64, and stays within the
default WebGPU storage-buffer limit. Changing method or grid quality at runtime
is GPU-tested.

The deterministic test translates a Gaussian of width 0.35 at speed 0.3 for
two seconds, at 60 Hz in a 16-unit, 64-cell domain, with sources, pressure-driven
motion, buoyancy, noise, diffusion, and explicit decay absent:

| Metric | First Order | Bounded MacCormack |
| --- | ---: | ---: |
| Relative L1 error against analytic translation | 0.38534 | 0.18406 |
| Peak after translation | 0.58949 | 0.75415 |
| Sum of sampled density | 43.21693 | 43.47659 |

The improvement is measured accuracy, not just extra energy. MacCormack is still
not mass-conservative (about 0.6% excess sampled density in this test), which is
one reason it is not promoted to the default.

Independent component bounds are insufficient for density-weighted heat/color:
bounding heat and density separately does not bound heat divided by density.
Higher-order transport additionally bounds specific temperature and color using
nonempty donor ratios. Tests cover constant color/temperature transport, mixed
hot/cold donors, no new density maxima, no negatives/nonfinite values, and a
solid `FluidCollider` slab with no measurable density crossing at 60 Hz.
No global temperature or color limit is imposed on user input.

The scheme follows
[NVIDIA's bounded MacCormack treatment](https://developer.nvidia.com/gpugems/gpugems3/part-v-physics-simulation/chapter-30-real-time-simulation-and-rendering-3d-fluids).

### Pressure Limitation Confirmed

The manual study now reports both centered and forward-difference divergence.
For a smooth seeded x-velocity, centered RMS divergence was 0.27275 before
projection, 0.24211 after 16 iterations and 0.18869 after 64. More iterations
help but the ordinary count does not produce a nearly divergence-free field.

For an alternating-cell x-velocity, centered interior divergence starts at zero
while forward-difference RMS is 8. After 64 iterations the latter is still 7.97;
centered divergence near the affected boundary increases to about 0.175. The
centered stencil is insensitive to this grid-scale mode. The forward difference
is an independent diagnostic, not a claim that the current cell-centered data
is a face-centered velocity field.

This supports making a consistent face/MAC pressure representation the next
solver correction. It does **not** prove that this mode caused the user's
observed thrashing. Raising iterations or tuning dissipation cannot substitute
for that correction. Higher-order transport remains opt-in while this is open;
it retains details that the current projection may not resolve adequately.

The window-focus/catch-up emission issue remains untouched. No matched
Blender-cache replay or Unreal run was completed in this corrective pass; the
analytic transport test is a matched known-solution comparison, not engine parity.

## Cool Gas

The old `vorticityStrength` was three animated noise accelerations. It could not
restore rotation lost to trilinear advection. It now applies curl confinement;
`turbulenceStrength` independently controls the previous animated noise.

Seed the same rotating cold sphere, turn off sources, buoyancy, noise and velocity
decay, then simulate two seconds at 60 Hz. Representative density-weighted RMS
speeds were 0.305 at confinement 0, 0.345 at 0.2 and 0.633 at 2. This test is
deterministic and part of `fluid.test.mjs`; it does not rely on emission bursts.

At confinement 0.75, normal continuous gas and a run containing a single 0.5-second step had similar
cool-gas speeds two seconds later (approximately 0.55 and 0.56). Removing source
velocity reduced motion instead of revealing a hidden source-damping problem.
These particle-emission runs are stochastic and do not establish the cause of
the window-return effect. Window focus, clocks, and catch-up emission are unchanged.
The absorbing edge layer did have a per-frame fade; it now uses elapsed time.

## Established Systems

[Niagara's reference](https://dev.epicgames.com/documentation/en-us/unreal-engine/niagara-fluids-reference-in-unreal-engine)
separates curl confinement, turbulence, dissipation, buoyancy, pressure, and source
scattering. The library now distinguishes the first two correctly. The Niagara
burst preset uses the published quick-start dissipation rates (3, 1.5, 0.8) and
temperature buoyancy (3.5). Its fast density decay is GPU-tested. Unreal itself
was not run, so this remains a parameter-port test, not a matched visual test.

An actual Blender 4.4.3 Mantaflow smoke bake was run: domain side 16, resolution
64, 60 Hz, sphere radius 0.45, inflow through frame 12, density/temperature 1,
initial upward speed 0.8, heat buoyancy 1, density buoyancy 0, vorticity 0.2,
dissolve off, adaptive domain off, open boundaries. Density projections at
0.5/1/2/3 seconds show a rising, broadening puff; peak density decreases from
0.91 to 0.16 without explicit dissolve. Total sampled density is not conserved.

The Blender-inspired RZMPS preset is deliberately **not** a numeric clone:
particle sources accumulate density rather than maintaining a mesh inflow value;
its temperature/velocity decay settings do not have equivalent Blender controls.
[Blender's solver script](https://github.com/blender/blender/blob/main/intern/mantaflow/intern/strings/smoke_script.h)
uses second-order advection, gravity-scaled heat/density forces, and a separate
heat field; RZMPS uses first-order trilinear advection and density-weighted specific
temperature. Consequently copying buoyancy or vorticity numbers alone cannot
produce identical plumes. Render opacity and source normalization also differ.
The comparison identifies those limitations rather than claiming visual parity.

Confinement follows the curl-magnitude-gradient force in
[Visual Simulation of Smoke](https://graphics.stanford.edu/papers/smoke/).

## Earlier Corrective Pass Plan

The plan below records the broader investigation proposal. The bounded gas-only
pass at the end of this document supersedes it as the current scope; it is not
an instruction to reopen the resolved FLIP bounds issue.

### 1. Establish Matched Inputs Before Tuning

- Export a Blender cache snapshot and initialize RZMPS with the same density,
  temperature and centered velocity fields. Convert axes, MAC face samples, grid
  velocity units, and separate heat into RZMPS's density-weighted temperature.
- Compare source-free evolution first; then match the inflow window and source
  normalization. A mesh inflow maintaining density 1 is not equivalent to a
  particle emitter accumulating density at rate 1.
- Capture orthographic density projections at identical simulated times and
  resolutions. Record centroid, spread, peak, integrated density, divergence,
  curl energy, and density-weighted speed. Use deterministic particle seeds.
- Acceptance: explain each parameter mapping and remaining algorithm difference;
  do not label an inspired preset a matched reference or copy coefficients blindly.
  Niagara still needs an actual Unreal run; its published rates alone are not
  evidence of visual parity.

### 2. Preserve Gas Motion Without Artificial Decay

- Measure first-order advection's velocity/curl loss independently of explicit
  `velocityDissipation`. Compare a bounded higher-order method such as MacCormack
  or BFECC against the existing trilinear path, including solid boundaries.
- Check the collocated pressure stencil's divergence residual and odd/even-cell
  modes; pressure iteration count alone does not establish incompressibility.
- Acceptance: cold source-free gas continues to rotate, uniform flow remains
  uniform, no new extrema/negative density appear, and wall flux stays bounded.
  Confinement must preserve existing rotation rather than inject a global drift.

### 3. Bound Resizing and Time-Step Error

- The cap is a practical mitigation, not proof of an otherwise stable FLIP solver.
  Run long tests at deliberate domain sizes 16/32/64 with the same initial liquid,
  both without colliders and inside the teapot. Log bulk mean velocity, new-marker
  velocity, occupancy, rest-density error, pressure residual, and resize events.
- Audit synchronization between GPU hash bounds and solver bounds, especially
  when uncapped GPU auto-expansion is enabled and CPU readback is 500 ms apart.
  Quantization prevents frequent resizing but does not preserve cell width.
- Decide whether to preserve physical cell width by growing solver resolution or
  keep a capped domain with explicit out-of-domain behavior and a memory budget.
  Empty hash bricks do not make the current dense solver cheap to enlarge.
- Sweep solver steps at 30/60/120 Hz and a large isolated step. Add solver-local
  CFL substeps if measurements justify them, with consistent source integration.
  Do not fix or alter the separate system window-focus/catch-up emission bug here.
- Acceptance: bounded bulk momentum and emitter speeds over at least 60 seconds;
  one escaped marker cannot change interior velocities or force global coarsening.

### 4. Finalize API Mapping and Presets

- Keep confinement and turbulence separate. Decide/document buoyancy's gravity
  scaling, temperature semantics, source velocity mixing, and dissipation units
  using the matched-input results, not appearance alone.
- Test runtime edits, bounds/resolution rebuilds, serialization, and GUI visibility.
  Recheck GPU buffer limits and field disposal for every new pass or scratch field.
- Tune the continuous gas and liquid demos only after those measurements, then
  record desktop/mobile captures and the accepted parameter mappings. Keep fluid
  tutorials out of the published documentation until behavior is settled.

Remaining uncertainty: the reported focus-return improvement is not reproduced
by the isolated large-step experiment. It may depend on a combination of elapsed
noise phase, source timing, bounds history, or an emission pattern that a simple
burst does not reproduce. Instrument these separately before attributing a cause.

## Bounded Gas Pressure Pass

### Scope And Endpoint

The user confirmed that unchecked bounds growth caused the FLIP thrashing and
that the bounds fix resolves it. This pass changes **gas only**: correct its
pressure operator, validate transport and collisions, compare the continuous
plume visually, and make one preset change if justified. Neither the shared
FluidSimulation solver nor FLIP, emission timing, or window-return behavior is
changed. The broader reference-engine comparison is not expanded in this pass.

### Correction

Gas now builds staggered face velocities from its cell-centered force/source
workspace. Divergence, pressure gradients, and the pressure Laplacian use the
same face stencil. Gas backtraces sample the projected faces componentwise,
rather than sampling a different, reconstructed center field. The force,
source, and curl kernels still use centered workspace velocities; this is not
a complete staggered velocity-advection rewrite.

Pressure uses red-black Gauss-Seidel: each iteration updates both cell colors
in separate GPU dispatches. Occupied collider faces have zero normal flow and
Neumann pressure; open domain faces have zero pressure at half a cell distance.
This follows the staggered discretization and boundary treatment in
[Bridson and Mueller-Fischer's course notes](https://www.cs.ubc.ca/~rbridson/fluidsimulation/fluids_notes.pdf),
especially sections 2.4 and 4. The internal helper lives in GasSimulation.ts,
is hidden from both module editors, and is disposed/recreated with grid quality
changes. Bounds remapping invalidates its face initialization.

At resolution 64 the face buffer adds approximately 4.19 MiB. MacCormack's
existing optional scratch buffers add another 12 MiB. Gas `pressureIterations`
now counts red/black pairs, not Jacobi sweeps; equal counts are not equal GPU
dispatch costs. Center speeds retain their magnitude cap; face components have
the same scalar cap. A triggered safety cap can reintroduce divergence, so the
operator-consistency measurement uses velocities below that limit.

### Numerical Results

- On a sinusoidal compression field with wavelength 2, side 16, resolution 64,
  16 pressure iterations reduce actual face-divergence RMS from 1.955307 to
  0.174463, approximately 91%. This is a convergence test, not proof that all
  wavelengths are solved to that tolerance in 16 iterations.
- Across fluid cells, projected divergence matches `rhs - Laplacian(pressure)`
  within 2.64e-7. The same consistency check passes with a FluidCollider slab;
  its blocked faces remain exactly zero. Both advection methods retain zero
  density inside the slab and no measured leak through it.
- Runtime pressure iteration changes 1/0/4/0 leave no stale pressure at zero.
  Uniform translation stays uniform. The existing Gaussian transport errors
  remain 0.385340 for semi-Lagrangian and 0.184060 for MacCormack; temperature
  and color remain attached to density, and mixed donor ratios stay bounded.
- The final continuous preset runs for 60 simulated seconds with no negative
  density or nonfinite values at the ten-second checkpoints. Sampled density
  peaks range 2.79-5.46, specific temperature stays at or below 1, and cool-gas
  speed stays approximately 0.77-0.85. The existing 60-second FLIP regression,
  escaped-marker case, gas reference presets, and cold-rotation checks pass.

### Visual Comparison And Preset Decision

`tests/visual/gas-review.mjs` captures the continuous preset at 2, 5, and 10
seconds with both a fixed side-16 domain and normal automatic bounds, plus
390x844 mobile views. It fixes the JavaScript random seed and uses 60 Hz steps;
GPU particle allocation and asynchronous bounds-readback timing still make
particle-emission runs stochastic, not bit-for-bit replayable.

Local artifacts from this pass:

- `/tmp/rzmps-gas-before`: original pressure, semi-Lagrangian preset.
- `/tmp/rzmps-gas-after`: corrected pressure, unchanged semi-Lagrangian preset.
- `/tmp/rzmps-gas-final`: corrected pressure, MacCormack preset.

At ten seconds with automatic side-8 bounds, measured cool-gas speed is 0.575
before, 0.592 with pressure alone, and 0.767 with the final preset. Corresponding
density peaks are 3.05, 2.51, and 4.06. These are illustrative captures, not a
controlled statistical performance or engine-parity claim. Pressure alone makes
only a modest visual difference. With MacCormack the plume retains more edge
structure and cool motion; it still has a broad, relatively uniform blue core.
The close desktop camera clips the top of the plume; the mobile capture shows
its full extent. No rendering/depth changes are included here.

The only production preset change is `advectionMethod: 'macCormack'` in Gas
Volume. Library defaults stay semi-Lagrangian, and source, force, dissipation,
confinement, and renderer settings are unchanged. Desktop and mobile canvas
pixel checks confirm a visible colored volume, and screenshots were inspected.

Reproduce final captures with:

```sh
node tests/visual/gas-review.mjs /tmp/rzmps-gas-review
GAS_ADVECTION=semiLagrangian node tests/visual/gas-review.mjs /tmp/rzmps-gas-first-order
node --test tests/visual/fluid-numerics.test.mjs tests/visual/fluid.test.mjs
```

### Stop Here

The agreed endpoint is reached: a consistent gas pressure/transport stencil,
GPU regression coverage, a stable minute-long plume, and an inspected preset
comparison. A complete MAC velocity solver, multigrid/convergence-driven
pressure, conservative scalar transport, finer visual tuning, and matched
Blender/Niagara cache tests remain possible separate passes. MacCormack still
does not conserve total density exactly, and coarse remapping still loses
detail. The window-return improvement remains unexplained; this pass neither
claims to reproduce it nor changes the separate emission bug.

Verification: `npm test --workspace @rzmps/rzmps`, both WebGPU fluid test files,
the gas capture script's desktop/mobile pixel checks, `npm run docs:check`, and
`git diff --check` all pass. Generated assistant references were refreshed by
the documentation generator; no fluid tutorial was published.

## Source Timing And Resting Liquid Pass

### Window Return Investigation

The user reports an improvement after window return under **both** advection
methods. Source tracing found no independent background gas loop: emission,
gas compute, particle integration, and render output execute in one system
update. They share the same delta uniform, which updates before dispatch.
System update LOD skips that whole path, not just movement. The demo calls
`system.update()`, whose delta comes from wall-clock time without clamping.

There is a concrete temporal asymmetry inside a long update: gas reads sources
at their **old positions and ages**, deposits for the whole step, and only then
does the particle integrator move and expire them. A returning frame can
therefore concentrate injection and apply a large velocity/noise impulse even
without catch-up births. This is not retained pressure building up: pressure
is reset on each solve. Density changes buoyancy/weight, while source momentum
and forcing change the velocity whose divergence pressure corrects.

`gas-timing-review.mjs` compares one 0.5-second step with thirty 1/60-second
steps after disabling all births, at fixed bounds. It repeats with the transient
visual overlay disabled. Before the source corrections below:

| Physical Fields Only | One Long Step | Thirty Small Steps |
| --- | ---: | ---: |
| Gas / movement dispatches | 1 / 1 | 30 / 30 |
| Time supplied to each phase | 0.5 s | 0.5 s |
| Density peak afterward | 10.98 | 3.60 |
| Accumulated heat afterward | 113.49 | 57.05 |
| Density-weighted speed afterward | 1.279 | 0.654 |
| Cool speed after two further seconds | 1.127 | 1.124 |

These stochastic runs demonstrate a physical large-step difference independent
of catch-up births or the transient overlay. They do **not** reproduce the
reported sustained visual improvement or prove the exact hidden-window cause;
after two seconds the sampled cool speeds were nearly identical. No browser
visibility behavior, global clock, or catch-up emission code was changed.

Gas-local corrections now bound persistent density, heat, color, and momentum
source duration by each particle's remaining lifetime. Source velocity blending
uses `1 - exp(-rate * integratedSourceWeight)` instead of a clamped linear
step, preserving constant-source relaxation across different step sizes. This
does not make a single long advection/noise/source-position step equivalent to
many short steps, and it does not intentionally recreate the return-frame kick.

The persistent/visual source distinction still matters: transient output reads
render-time particle attributes, but its radius-query candidates are selected
using main-buffer positions. A large transient position change can omit visual
contributions. That sampling mismatch remains a separately identified follow-up,
not a proven cause of the user's observation.

### Source Collision And API

Gas Volume now includes `Collision({ lifetimeLoss: 1 })`. Its grid occupancy
colliders stop Eulerian flow, while the Collision module kills source particles
at scene geometry so they cannot cross it and deposit gas on the other side.
A controlled slab regression kills the source in its first contact update;
the following update adds no density across the wall. Alpha 0.5 produces half
the persistent density of alpha 1. A particle with 0.01 seconds left deposits
the same amount in a 0.5-second update as a live source does in 0.01 seconds.
Existing gas no-through-slab tests still exercise **grid** collision separately.

`AdvectionMethod` is now a public string enum with `SemiLagrangian` and
`MacCormack`. The input/property type is `AdvectionMethod | \`${AdvectionMethod}\``,
so enum values and existing string spellings both work. Type tests reject
unsupported strings; no legacy-instance guards or compatibility layer were added.

The actual gas baffle scene was captured with source collision enabled at
2/5/10 seconds and on desktop/mobile. It retains fewer source particles than
the checkerboard plume because contact now kills them. The volume remains
visible below/around the splitter rather than being supplied by markers flying
through it. Local artifacts: `/tmp/rzmps-gas-flow-source-collision`.

### Resting Liquid Chains

The initial teapot run had approximately 45.3% of markers within half their
requested spacing at 30 seconds; 17.0% were within one tenth. Inspection found
three particle regularization defects:

- Exact overlaps had a zero displacement direction and could never separate.
- Averaging every pair correction by neighbor count weakened separation as
  clusters grew. Pair spacing also depended only on the querying marker's size.
- Most importantly, an existing wall contact discarded **all** remaining
  separation displacement, including its tangent component. Once resting on
  a wall, overlapping particles could remain locked there despite regularization.

Separation now accumulates bounded half-pair corrections, uses mean pair scale,
queries far enough for mixed-size neighbors, and gives coincident pairs a stable
antisymmetric hashed direction. The existing per-frame movement cap and deferred
commit remain. The contact response removes inward normal motion but retains
tangential separation, so markers can spread while resting on the collider.
Optional grid advection refreshes hash membership before separation queries.

The approach follows the separation/drift distinction in
[Mueller's FLIP tutorial](https://matthias-research.github.io/pages/tenMinutePhysics/18-flip.pdf):
grid incompressibility does not itself maintain an even marker distribution.
This is still position regularization, not an added attractive/repulsive
particle velocity force or a replacement fluid algorithm.

An experimental nonnegative-pressure clamp worsened containment and was
removed. Increasing separation to two passes without fixing contact tangents
also left severe overlaps and was removed. The shared pressure solver and its
signed-pressure behavior are unchanged by this pass.

With the final contact fix, the 15/30/50-second capture had near-coincident
fractions 0.095% / 0% / 0%, all 6,292 particles remained in the teapot, and median
spacing ratios were 0.80 / 0.84 / 0.92. The half-spacing fractions were
14.9% / 27.9% / 9.8%. A separate 30-second regression measured 0% near-coincident,
4.7% below half spacing, and median spacing 0.91. Stochastic runs vary, so this
is evidence of improved packing, not a claim of exact incompressibility or
perfect spacing. Local captures: `/tmp/rzmps-flip-chain-before` and
`/tmp/rzmps-flip-slide-final`.

Focused GPU tests cover coincident pairs, unequal sizes, zero added velocity,
and tangential spreading at a resting wall contact. The long teapot regression
now measures nearest-neighbor packing as well as containment and velocity, so
a full-looking container alone cannot pass while particles collapse into chains.

### Separate Collision Cache Finding

Adding a wall **after** the first GPU collision dispatch exposed an unrelated
backend invalidation defect: BVH topology updates replace storage, but the
ParticleSystem collision compute cache keys backend identity/module version,
not backend storage revision. The compiled query can keep old buffers. A late
wall was missed (source x=1 then x=2); the identical wall present before the
initial render correctly killed it. This is not a GasSimulation occupancy error.

No general collision-cache rewrite is included. The focused preset regression
creates scene geometry before the initial render, like the demo. A future
GPU-collision pass should add a backend topology/resource revision to dispatch
cache invalidation and test late additions/removals plus transformed geometry.

### Reproduction

```sh
node tests/visual/gas-timing-review.mjs /tmp/rzmps-gas-timing
GAS_SCENE=gasFlow node tests/visual/gas-review.mjs /tmp/rzmps-gas-colliders
node tests/visual/flip-review.mjs /tmp/rzmps-flip-packing
node --test tests/visual/fluid-sources.test.mjs tests/visual/flip-separation.test.mjs
node --test tests/visual/fluid.test.mjs tests/visual/fluid-numerics.test.mjs
```

Final verification: package build/type/runtime tests, all four WebGPU test files
above, desktop/mobile gas captures, documentation generation/checks, and
`git diff --check` pass. The combined final run measured 0% near-coincident
markers, 24.9% below half spacing, and median spacing 0.85 at 30 seconds; its
60-second gas run had no negative/nonfinite field values. No general emission,
timing, GPU collision-cache, or shared pressure-solver rewrite is included.
