# Fluid Rendering Workbench

These presets exercise GPU fluid solvers. The FLIP demo now uses experimental GPU
Surface Nets mesh construction. See the [surface construction notes](liquid-surface-construction.md)
and [performance diagnostic](fluid-performance-diagnostic.md) for investigation and next steps.

## Liquid Surfaces

`SurfaceRenderer` reconstructs real triangles from GPU particle positions, scale,
alpha and color, including transient changes and renderer children. It works
independently of FLIP and does not change simulation motion or collisions.
`voxelSize` controls reconstruction detail independently of solver grid quality;
`particleRadiusScale` controls blending support and `isoLevel` controls erosion.
Use `maxActiveBricks`, `maxTriangles` and `readSurfaceDiagnostics()` to check budgets.
Reconstruction `bounds` are coverage, not walls; out-of-coverage kernels are
reported as clipped particles. Native WebGPU particle processing is required.

Particle-weighted vertex colors tint the renderer-owned material clone by default.
A white material retains the particle palette; `particleColors: false` disables
automatic modulation. Custom fragment graphs must explicitly consume the color
attribute if they bypass Three's normal vertex-color path. The construction notes
document that contract and the remaining material questions. Paired GPU smoothing
is controlled by `smoothingIterations` (default 3) and `smoothingStrength` (default 1);
zero disables smoothing. The FLIP preset passes a `MeshPhysicalMaterial` with
water-like transmission, IOR and absorption. The teapot scene supplies studio
reflections. Thickness remains a material constant, not measured fluid depth.

The teapot demo starts with centered eight-unit solver bounds so it does not
change from a coarse to a finer grid partway through filling. Liquid and gas
share matched face-based pressure projection; liquid transfers before/after
face velocities to markers. See the [settling investigation](../../tests/visual/fluid-study.md#liquid-lifecycle-and-settling-correction-october-28-2026)
for restart fixes, packing measurements and remaining sub-grid boundary limits.

The interactive preset now uses 3+4 subdivisions, a 32,000-particle budget and
continuous emission with its existing 60-second lifetimes. Numerical fixtures
retain a finite, 64-cell reference configuration unless `demoLiquid` is requested.
In the Fluid Teapot scene, Scene Settings exposes a manual tip slider and an
automatic tipping loop, enabled by default with a ten-second period and a 45-degree angle. The emitter
and floor stay fixed while the vessel and its collider move together.
The slider sets a target angle; Tip Speed limits motion to 30 degrees/second by default.
FLIP also sweeps against rigid collider transform motion using its existing BVH.
The demo surface coverage matches the sixteen-unit simulation cap, with larger
meshing budgets for spilled liquid; simulation and mesh voxel sizes remain independent.
Fast, isolated liquid markers emit a GPU spray subsystem using `spray_alpha.png`.
These short-lived, fading sprites inherit liquid velocity and color without a second
fluid solve. They are separate from the liquid surface; foam remains deferred.

See [liquid quality and whitewater](liquid-quality-and-whitewater.md) for measured
solver-versus-rendering costs, comparison-software findings, and proposed next
steps for sparse liquid work, finer sampling, surface quality and secondary effects.

## Current Volume Rendering

`VolumeRenderer` discovers tag-overlapping `VolumeFieldProvider` modules and
combines their fields during one ray march. Explicit fields still take
precedence. None of the appearance controls below change simulation state.

### Render Children

Children reuse each density/color field as deterministic displaced, uniformly
scaled field copies. They are an inexpensive density/coverage approximation,
not independently simulated gas or independently randomized children per voxel.
All voxels in a field share the displacement stencil. Zero-radius unit-scale
copies coincide with their parent, so their alpha-weighted densities simply add.
There is deliberately no mass normalization or collision masking.

The existing `children` count, radius, scale, alpha, variation, and radial easing
controls apply. Radius is in simulation units. Scale changes a copy about the
source field's center; color follows the same transform. Bounds include all
copies. Child count/ranges/sets and appearance curves are evaluated on CPU once
per update. Numeric TSL constants/uniforms work; opaque GPU-only expressions are
rejected. Copies share source textures, rather than multiplying texture bindings
or allocating particle buffers. Sampling cost still grows with copy count.

`generateChildren` now defaults to true on volume renderers, matching other
renderers. Count still defaults to zero. Turning generation off skips the
stencil entirely. `renderedChildCount` counts additional field copies, not
particles or voxels. LOD children use cell-scale displacement; size compensation
scales field copies. These are visual approximations, not physical resampling.

### Filtering And Density Controls

- `interpolation`: `VolumeInterpolation.Nearest`, `Linear` (default), or `Cubic`.
  Cubic uses a smooth B-spline reconstruction with eight hardware-linear reads,
  not the gas solver's advection algorithm. Source textures must support linear
  filtering for Linear/Cubic; the built-in field producers configure this.
- `stepSizeMultiplier`: ray spacing relative to the smallest contributing cell.
  Smaller values improve integration quality. `steps` caps the work at 512.
  Distance-corrected opacity keeps ray quality from acting as a density control.
- `densityGain`: multiplies render density, independently of source strength.
- `densityMapping`: `Smoothstep` (default, existing threshold/range), `Linear`,
  `Curve`, or `None`. Linear/Curve use `densityRange`, default `[0, 1]`.
- `densityCurve`: existing `ValueByParameter<number>` convention, evaluated on
  range-normalized density and sampled into a 256-entry lookup texture. Zero
  density remains transparent even if the curve has a nonzero first value.
- `noiseStrength`: nonnegative exponent on the procedural density mask. Zero
  disables masking, one applies the mask directly, and larger values erode more.
- `noiseContrast`: nonnegative sharpening around noise value 0.5, default one.
  The mask is `pow(clamp((noise - 0.5) * noiseContrast + 0.5, 0, 1), noiseStrength)`.
  Contrast is applied before the exponent. Both controls are runtime uniforms;
  positive values are not capped by the API. Animated masking requires WebGPURenderer.
- `adaptiveStepping`: opacity-aware ray step growth, now disabled by default to
  favor visual detail. Scene-depth clipping remains enabled by default.

The Gas Volume demo uses 3 brick plus 4 cell subdivisions, emits 300 particles per
second at radial speed 1.5, and shrinks particles to 20% of their initial size.
Its density mask defaults to strength 2 and contrast 1.5. Gas uses the library's
default budget of 512 resident bricks, capped by logical brick count. Active/new
brick lists drive GPU work independently of unused reserved capacity. The field
buffers still reserve memory for the pool: lower `maxActiveBricks` explicitly for
memory-constrained use. Cell subdivisions multiply per-brick memory eightfold.
Changing the budget rebuilds the fields, and device buffer limits still apply.

Blender inspires reconstruction selection. Niagara inspires cell-relative ray
spacing, separate density gain, range, and curve mapping. Unity inspires the
separation between texture reconstruction and simulation. Unity's texture
`Trilinear` option also blends mip levels; dynamic simulation fields do not
currently have mip chains, so that name is not exposed as a misleading mode.

## Investigation

- [Liquid surface construction plan and teapot spout findings](liquid-surface-construction.md)
- [Performance, adaptive resolution, libraries, and render-only noise](fluid-performance-diagnostic.md)

## References

- [Obi fluid rendering and Surface Nets][obi]
- [Blender liquid mesh controls][blender-mesh]
- [Blender Mantaflow reconstruction source][blender-source]
- [Niagara fluid render controls][niagara]
- [Niagara surface ray marching overview][niagara-overview]
- [Unity Texture3D sampling][unity]

[obi]: https://obi.virtualmethodstudio.com/manual/7.0/fluidrendering.html
[blender-mesh]: https://docs.blender.org/manual/en/4.5/physics/fluid/type/domain/liquid/mesh.html
[blender-source]: https://github.com/blender/blender/blob/main/intern/mantaflow/intern/strings/liquid_script.h
[niagara]: https://dev.epicgames.com/documentation/en-us/unreal-engine/niagara-fluids-reference-in-unreal-engine
[niagara-overview]: https://dev.epicgames.com/documentation/en-us/unreal-engine/fluid-simulation-in-unreal-engine---overview
[unity]: https://docs.unity3d.com/Packages/com.unity.visualeffectgraph@17.0/manual/Operator-SampleTexture3D.html
