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

## Corrective Pass Plan

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
