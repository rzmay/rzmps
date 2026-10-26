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
The normal 30-second collection test and the injected-outlier test are covered
by `fluid.test.mjs`. This demonstrates the grid-growth failure mechanism, not
proof that every possible long-running instability has been eliminated.

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
