# Fluid Rendering Workbench

These presets exercise GPU fluid solvers. Liquid surface construction is planned,
not implemented. See the [surface construction plan](liquid-surface-construction.md)
and [performance diagnostic](fluid-performance-diagnostic.md) for investigation and next steps.

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
