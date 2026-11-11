# Fluid performance, collection, and opacity follow-up

This pass addresses sustained liquid slowdown, gas domain-change stalls, collider discovery,
resolution-dependent opacity, and weak preset turbulence. It does not retune the liquid
pressure model, implement physical viscosity, or resolve the remaining teapot outlet issue.

## Sustained liquid slowdown

The native WebGPU demo reproduced the reported slowdown around 12–13,000 live particles.
Late update intervals reached 45–62 ms while CPU update submission stayed near 2 ms and
simulation bounds stayed at 16 cubed. Bounds expansion was not the trigger.

The surface renderer saturated its 2,048-brick pool. The sparse allocator ran on one GPU
invocation: for every requested nonresident brick it searched the resident slots for a free
one. At capacity, rejected requests each scanned all 2,048 entries. The benchmark found
106 overflowed requests in the baseline snapshot. This work grew as liquid spread over the floor.

`SparseVolumeGrid` now releases retired pages in parallel and builds a compact free-slot list.
A separate dispatch claims those slots in parallel, once per requested logical brick. Retained
pages keep their addresses, and each new claim gets a unique slot. Overflow counting remains
explicit. Existing indirect active-cell dispatch is unchanged. The improvement applies to
surface reconstruction, gas, and FLIP work grids rather than adding a liquid-specific allocator.

In a queue-fenced replay of the late dispatch sequence, work outside the named solver/surface
stages dropped from about 21.5–21.7 ms to 3.2–3.9 ms after warmup. The baseline also measured
particle-to-grid transfer around 4.5–4.8 ms, pressure around 5 ms, reconstruction around 1.9 ms,
and smoothing around 1.3–1.4 ms for its two-step update. These fenced wall times include
submission/synchronization and are not GPU hardware timestamps or additive frame costs.

The corrected run completed 3,000 frames, reached approximately 13,000 particles, and retained
a 16.7 ms median update interval over its final 600 frames. Subdivisions, emission, smoothing,
material, triangle budget, and brick budget were not reduced to obtain that result. Local
hardware/browser results are not a frame-rate guarantee.

The final surface still reached both its 2,048-brick and 262,144-triangle limits. Overflow
means incomplete reconstruction, not a solver error; additional spilled liquid can still be
clipped by those budgets or the fixed surface bounds. Raising budgets costs memory and mesh
work. That quality decision remains separate from removing the allocator's unnecessary search.

## Gas resizing and prediction

A world-domain resize already reuses the gas cell buffers. Existing scalar ping-pong buffers
provide separate read/write storage for resampling, while the previous page table resolves old
addresses. It does not require another full gas volume allocation.

Two shader graphs previously embedded each old domain's minimum and cell size: resident-brick
marking during resize and field resampling. They now use uniforms and cached graph variants;
both scalar remap variants are compiled during non-advancing preparation. Velocity-copy work
is cached as well. Repeated bounds changes therefore do not create a new graph per resize.

A resident-pool capacity increase is a different operation. It changes storage strides and
bindings, migrates fields, and rebuilds solver pipelines. The recorded Gas Volume run grew
from 64 to 128 resident bricks while still using a small 4-cubed world domain. Its largest
sampled CPU update was 262.8 ms, dominated by first-use solver pipelines. The following
4-to-16 domain remap took 19.5 ms in that run. The workload had already included the first
remap caching change, so this is not an untouched historical resize baseline.

Automatic gas padding now includes particle-motion lookahead, even before any measurable gas
has accumulated. `velocityPaddingLookahead` defaults to one second. This is combined with the
existing buoyancy/diffusion estimate using the larger distance, not an unbounded maximum-speed
forecast for the entire density lifetime. Prediction remains approximate: external movement,
parameter changes, unusually long-lived smoke, and sudden bursts can still require growth.

A forced live cycle through side lengths 16, 32, 64, 32, and 16 measured the four domain-change
updates at 4.2, 3.6, 1.2, and 1.4 ms CPU submission. The final contraction subsequently exceeded
the resident pool and still caused a 277 ms growth update. This isolates the remaining pipeline
replacement cost from ordinary world-bounds resampling; pool capacity growth is not solved.

The Gas Volume preset starts with the expected 16-cubed plume domain, zero manual padding,
and automatic padding enabled. Its 600-frame verification stayed at that size, had no pool
growth, and had a maximum sampled CPU update of 3.2 ms. This fixes that preset's early spike;
it does not claim arbitrary future pool growth is hitch-free. Fully asynchronous pool staging
would need to keep the old binding set alive while preparing a replacement solver before
swapping it in. That additional resource lifecycle is not implemented in this pass.

## Opt-in collider collection

`collisionOptions` opts either fluid module into scene collection; omission disables it.
The existing nested API accepts the same membership settings as Three's collision backends:
`world`, `staticObjects`, `dynamicObjects`, `objectFilter`, `staticObjectFilter`, and
`dynamicObjectFilter`. It also supports GPU geometry-dynamic roots/filters and `updatePolicy`.
Explicit lists, including empty lists, suppress scene discovery. Omitting `world` uses the
owning scene. An object typed as `ThreeCollisionBackendOptions` can be passed directly.

`staticAfter` now mirrors the octree backend's two-second default. Automatic wrappers track
transforms and geometry revisions: moving objects are rigid-dynamic, stationary ones become
static, and geometry edits invalidate their baked field and local BVH. Static/rigid wrappers
can cache occupancy. Explicit classification remains authoritative. Application geometry is
never reparented or disposed by the collector. Octree subdivision/rebuild settings remain
physics-backend settings, rather than fluid-grid controls.

The liquid and gas presets enable discovery with a small contact shell for open surfaces such
as the checkerboard plane. The teapot scene and gas-flow scene contain ordinary rendered
meshes; their explicit FluidCollider proxies have been removed. The teapot uses the liquid
preset's 48-sample baked-field quality. General checkerboard and collision-demo meshes are
discovered the same way. Native browser checks found two collected meshes in the teapot scene,
five in Gas Flow, one in Checkerboard, and five in the collision demo. The final proxy-free
teapot run completed 3,000 frames with 14,194 particles, a 16.7 ms median interval over the
last 600 frames, and zero non-finite field samples. Arbitrarily thin/open geometry still needs
an adequate contact shell and grid/bake resolution.

## Grid-independent opacity

The reported opacity change was real. Integration previously divided ray-segment length by
the current field cell size. A finer grid produced a higher optical thickness for the same
constant density, even though variable ray-step lengths were already compensated.

Mapped `opacity` now always applies over one simulation unit of ray travel. The reference
distance is fixed internally, with no additional renderer option or GUI control. Integration
uses `1 - (1 - mappedOpacity) ** segmentLength` on both backends. Grid cell size still chooses
sample spacing; it no longer defines optical thickness. The general Gas Volume preset uses
opacity 0.75, approximately preserving its previous mature-plume optical thickness. Changing
simulated density through a different solver resolution can still change appearance; that is
separate from the renderer's integration invariant.

This follows the density/extinction approach used by established volume materials. Blender's
[Principled Volume](https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/volume_principled.html)
exposes density; Unreal's [heterogeneous volume renderer](https://dev.epicgames.com/documentation/en-us/unreal-engine/heterogeneous-volumes-in-unreal-engine)
keeps ray-step quality separate from the volume material. A second distance control is not
necessary for this library's simpler opacity API.

The native marching regression compares identical constant-density fields at 8, 16, and 32
cells per axis, along with multiple step counts, adaptive step factors, and scene-depth cases.

## Turbulence and vorticity

`turbulenceStrength` controls independent animated procedural-noise acceleration, in simulation
units per second squared. It creates motion even in an initially quiet region. It is applied
to the simulated velocity before pressure projection; projection removes its divergent part.

`vorticityStrength` controls confinement: compute curl, find the gradient of curl magnitude,
and apply a force perpendicular to that gradient and the curl. This reinforces existing
rotation lost to grid advection. It does not create a swirl in a perfectly still, uniform field.
Density-mask noise only changes rendering and has no effect on either force.

Gas Volume uses turbulence 2 and confinement 4 (previously 0.75 and 2). Steam Burst uses
1.25 and 3; Volumetric Smoke uses 0.8 and 3. These are visual demo settings, not claims of matching
Niagara/Mantaflow coefficient units. The final Gas Volume diagnostic remained finite with a
maximum field speed near 2, comfortably below its safety ceiling.

## Reproduction

Build the library before browser checks. Runtime tests disable their Vite watcher so an existing
workspace build watcher cannot hot-reload and silently reset a long-running diagnostic.
Screenshots are captured before destructive stage replay.

```sh
npm test --workspace @rzmps/rzmps
FLUID_PRESETS='FLIP Fluid' RUNTIME_FRAMES=3000 node scripts/tests/preview/fluids/runtime-performance.mjs
FLUID_PRESETS='Gas Volume' RUNTIME_FRAMES=600 node scripts/tests/preview/fluids/runtime-performance.mjs
node scripts/tests/preview/fluids/corrective.test.mjs
node --test --test-concurrency=1 scripts/tests/preview/fluids/volume-marching.test.mjs scripts/tests/preview/fluids/volume.test.mjs
```

Local raw captures: `/tmp/rzmps-fluid-stage-baseline`, `/tmp/rzmps-fluid-stage-after`,
`/tmp/rzmps-gas-resize-baseline`, and `/tmp/rzmps-gas-resize-after`.


## Effect-based preset names

The former software-comparison presets are now Steam Burst (`steamBurst`) and Volumetric Smoke
(`volumetricSmoke`). The former emits a single white pressure puff every two-second loop and fades
quickly. The latter uses a fixed plume domain to keep slow dissipation from inflating its predictive
padding. It emits a narrow charcoal plume over a five-second loop, with gradual density
decay, upward heat-driven flow, a slight crosswind, and rolling confinement. Their descriptions
retain Niagara Fluids and Blender inspiration respectively; the coefficients are artistic
settings, not numerical reproductions of either engine.
