# Fluid infrastructure review

November 10, 2026. This is a bounded corrective pass, not a replacement fluid solver.

## Current structure

`FluidSimulation` owns shared GPU fields, bounds, occupancy, and collider collection within the
module lifecycle. FLIP uses particle/grid transfers, face-pressure projection, separation, and
swept collision; its dense-addressed fields dispatch occupied bricks. Gas uses sparse brick-pool
fields with advection, projection, diffusion, buoyancy, and decay. Transient color/scale/alpha
feed a render-time source pass. `VolumeRenderer` consumes tagged field providers;
`SurfaceRenderer` independently reconstructs the colored liquid mesh.

## Changes and verification

Niagara emission now lasts **2 seconds**, Blender smoke **5 seconds**. Buoyancy is 1.8 for
Gas Volume, 5 for Niagara, and 1.5 for Blender. These are demo tuning values, not exact engine matches.

The liquid's existing whitewater is **spray, not persistent surface foam**. Larger low-opacity additive sprites
use soft intersections, fade in/out, and die on collider contact. The bounded two-second GPU review
counted **246 spray particles** alongside 900 liquid markers; isolated-spray screenshots confirm
rendering. Spray now shares the liquid's fine spatial index instead of building a coarser extra grid.
The demo kills markers outside the explicit 16-unit cap; the library default remains Ballistic.

Mesh collection is opt-in on either simulation:

```js
const collisionOptions = { world: scene, objectFilter: object => object.userData.fluidBoundary === true };
const liquid = new FLIPSimulation({ collisionOptions });
const gas = new GasSimulation({ collisionOptions });
```

The API mirrors `world`, static/dynamic roots, object filters, and GPU geometry-dynamic
classification. Explicit lists, including empty lists, suppress scene discovery. Wrappers follow
mesh transforms without reparenting/owning geometry. Open surfaces need a contact shell and
sufficient baked-field resolution. Explicit effects remain supported; gas source particles
can still need their own Collision module.

## Startup: measured cause

Gas unnecessarily replaced its constructor fields/textures on the first update. It now retains
them, and the base constructor no longer allocates a temporary full dense grid for sparse gas.

In the final native Chromium/WebGPU run at 3+4 subdivisions: construction took **12 ms**, initial
render **37 ms**, and first update **436 ms CPU / 497 ms including the GPU fence**. After the
first two warm frames, updates took roughly **1–4 ms CPU / 2.9–9.7 ms fenced** with 45 sources
and eight active bricks. These are small-workload startup measurements, not steady demo FPS.

First use builds shader graphs, synchronously compiles compute pipelines, and initializes/uploads
storage. The 512-brick pool reserves about **320 MiB of cell buffers**, plus faces/textures, even
with eight active bricks. Sparse dispatch saves work, not initial reservation. This explains good
steady FPS despite startup delay. A non-advancing preparation lifecycle using `compileComputeAsync`
and staged uploads is the next option, not implemented here.

## Remaining liquid issues

**Conservative occupancy is intentional:** every nonzero occupancy sample remains fully solid.
Filtered baked occupancy (48 cubed in the teapot), contact padding, and binary solver cells can
reduce the spout's effective pressure opening despite valid triangle clearance. This pass keeps
that safety rule. Fractional/cut-cell boundaries or a better conservative surface representation
need a separate design; the spout is not claimed fixed.

Pressure starts from zero each step and uses 28 red/black iterations in the demo. Large or narrow
liquid domains can remain under-converged, so hydrostatic driving pressure deserves a residual
diagnostic. PIC blending, binary walls, and surface reconstruction also contribute to apparent
viscosity/chunkiness. Their relative contributions are not yet measured separately.

At 450 markers/second and 60-second lifetimes, emission can sustain 27,000 markers before escape/death culling.
More particles increase transfer, separation, collision, meshing, and spray selection costs;
spreading also activates more bricks. A bounds cap does not cap occupied work inside it. Swept
particle collision works, but pressure still uses stationary solid-face velocity for moving walls.

## Volume artifacts

Rays follow the camera. The old integrator redistributed samples whenever its rounded sample count
changed, which can produce camera-dependent sampling discontinuities. It now keeps cell-based spacing until
the explicit step budget requires larger steps, preserving partial-segment opacity integration.
The gas demo uses 128 rather than 80 maximum steps. Strong, sharpened noise can still alias when
under-sampled; this pass adds no temporal reconstruction and does not claim all angles are solved.
Native opacity/depth checks pass for perspective, orthographic, inside-volume, and reversed-depth views.

Reproduce the bounded measurements/screenshots with
`node scripts/tests/preview/fluids/infrastructure-review.mjs /tmp/rzmps-fluid-infrastructure`.
