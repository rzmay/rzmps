# Surface Attachment and Liquid Foam

`SurfaceAttachment` is a persistent particle-motion constraint for CPU and GPU systems. It queries a surface after
integration, corrects normal displacement, and damps surface-relative tangential velocity. It leaves emission and
rendering to ordinary emitters, subsystems and renderers.

```ts
import { SurfaceAttachment } from '@rzmps/rzmps';

const attachment = new SurfaceAttachment({
  surface: mesh,
  offset: 0.01,
  adhesion: 60,
  tangentialDrag: 2,
  inheritSurfaceVelocity: 1,
  detachDistance: 0.25,
});
```

The default mesh/subtree query reuses triangle BVH infrastructure. Rigid translation and rotation update transforms;
they do not rebuild the geometry BVH. Surface velocity is the displacement of the sampled material point between
transforms divided by the update interval, including rotation and scaling. The first observation is stationary.

Distances and velocities use world units regardless of particle simulation space. Positive distance and offset point
outward; negative distance is inside the oriented surface. Mesh winding defines orientation, so an open mesh has two
oriented sides rather than a closed interior. Nonuniform mesh transforms are respected by world-space triangle tests.

`adhesion` and `tangentialDrag` are rates per second, evaluated with exponential responses. Zero drag preserves sliding;
positive drag gradually follows the inherited surface velocity. This does not pin a particle to one triangle or replace
its entire velocity with the surface velocity. `detachDistance` measures absolute error from `offset`; its default is
unbounded. An invalid or distant query leaves a particle ballistic for that update, or kills it with
`killOnDetach: true`. No persistent attachment identity is stored, so a surviving particle can reattach on a later query.

## Custom surfaces

Supply `sampler` for CPU processing or `samplerGPU` for GPU processing. Each function receives a world-space query
position and returns `distance`, outward `normal`, physical world-space `velocity`, and optional CPU / required GPU
`valid`. A CPU-only override selects CPU processing. GPU-only implicit surfaces require GPU processing; no CPU field
readback is used as a fallback.

```ts
const foamAttachment = new SurfaceAttachment({
  surface: liquidRenderer,
  samplerGPU: liquidRenderer.sampleSurfaceGPU,
  offset: 0.015,
  adhesion: 90,
  tangentialDrag: 2,
  detachDistance: 0.2,
  killOnDetach: true,
});
```

`SurfaceRenderer.sampleSurfaceGPU` is a bound method backed by the reconstructed liquid's final filtered implicit
field. The internal `LiquidSurface` instance exposes the same method. Binding the public renderer method keeps the
closure valid across reconstruction-pool replacement, clear and restart. Before reconstruction or outside supported
coverage, it returns an invalid sample. It never queries the generated triangle mesh or builds/refits a liquid BVH.

One eight-corner stencil provides the interpolated scalar and analytic trilinear gradient. Density is high inside
liquid, so the outward normal is the negative gradient and near-surface distance is
`(isoLevel - field) / length(gradient)`. Weighted reconstructed momentum/density at the estimated surface position gives
velocity. The approximation is local: flat bulk interiors and points farther than two reconstruction cells from the
estimated surface are invalid. It is not a global signed-distance field. Optional vertex-only mesh smoothing can shift
the rendered mesh slightly relative to that implicit surface; use `offset` for the desired visual separation.

Sampling reads the most recently completed reconstruction, including closing and scalar filtering. Intermediate
substeps that skip renderer updates reuse that snapshot. Queries add no reconstruction work or synchronization, and
cost scales with attached particles/local field reads rather than triangle count. Render-output velocity is physical
velocity, including the particle speed multiplier; transforming local simulation frames contributes rigid motion too.

## Foam and spray

`FLIPSimulation.FoamCondition` selects active, partially supported source markers using deformation, age and neighbor limits.
Pass `samplerGPU: surfaceRenderer.sampleSurfaceGPU` and `minimumDeformity` (inverse seconds) to use the same
reconstructed symmetric strain magnitude as liquid shading. With a sampler the threshold defaults to `0.5`, matching
the start of the material's default deformation range. Uniform translation and rigid rotation alone do not pass this
gate. Surface queries without deformation cannot be used with a positive threshold. Without a sampler deformation
filtering is disabled; an optional `minimumSpeed` gate defaults to zero.
It returns the existing `shouldEmitGPU` callback and managed spatial-grid options, just like `SprayCondition`. The
minimum neighbor count rejects isolated airborne markers; the maximum approximates free-surface support. This is a
local heuristic, not a full air-entrainment or foam solver.

Use a separate secondary system with inherited initial velocity, `SurfaceAttachment`, lifetime fading, and translucent
soft `SpriteRenderer` particles. The [FLIP Fluid demo](../examples/flipFluid.md) uses white, transmissive bubble sprites with existing
textures and three render children per marker. Foam follows the liquid while retaining independent sliding. Spray remains a separate
ballistic subsystem using `SprayCondition`, with no attachment module and no required surface-renderer dependency.

## Profiling

The liquid benchmark selection includes a surface-foam case. Its report records live foam count, a surface-query GPU
microbenchmark, full attachment GPU cost, and a foam-only rendering pass. Query and attachment kernels read the same
frozen state and write scratch buffers; full attachment includes the query, so those two measurements are not additive.
Production constraints stay fused with particle integration, and the ordinary frame report labels that combined foam
scope separately from FLIP, surface reconstruction, spray and scene rendering. CPU submission, GPU execution and fenced
wall time remain distinct. Deep traces remain opt-in; see [benchmark controls](./benchmarks.md).

## Liquid normal-noise animation

`LiquidMaterial.flow.noiseSpeed` controls the advection phase's cycles per second. It defaults to
`[0.2, 0.2]`, preserving the original constant animation rate. Zero freezes the phase; `advection`
still controls the distance traveled along the local fluid velocity. Like other flow settings,
`noiseSpeed` accepts a `ValueByParameter` driven by surface activity. Use `[speed, speed]` for a
constant rate, for example `material.setFlow({ noiseSpeed: [0.4, 0.4] })`.

The demo exposes **Noise Speed** under **Surface Renderer → Material → Flow**. Changes
use the existing material update path without rebuilding the liquid surface.

## Surface output addresses

Liquid reconstruction pages and generated mesh output grow independently. Built-in Surface Nets uses
compact vertex addresses; these addresses can change between frames. Use the implicit surface query
for particle attachment rather than retaining mesh vertex indices.

Custom `SurfaceExtractor` functions select `SurfaceVertexLayout.Triangles` (the default),
`SurfaceVertexLayout.Cells`, or `SurfaceVertexLayout.Compact`. Import the enum from `@rzmps/rzmps`. A factory can also
set `vertexLayout = SurfaceVertexLayout.Compact`: the context supplies `maximumVertices` and an atomic `vertexMap`.
Store `outputVertex + 1` at the source cell address; zero means no vertex. Keep output writes below
`maximumVertices` and report requested vertex/triangle counts through the existing counters. Smoothing
storage is temporary and may reuse filtering scratch after extraction starts.
