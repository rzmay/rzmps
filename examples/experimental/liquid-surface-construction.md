# Liquid Surface Construction Plan

Design only, not an implemented API. See [the workbench](README.md) for current volume controls
and [the performance diagnostic](fluid-performance-diagnostic.md) for resolution and optimization findings.

## API Inspiration

The primary model is [Obi's fluid surface mesher and rendering passes][obi].
It produces real geometry using Surface Nets, separates rendering groups from
physical fluid mixing, and exposes voxel size, isosurface offset, smoothing,
and memory budgets. Obi is a third-party Unity package, not native VFX Graph.

Blender inspires independent reconstruction resolution, particle-radius control,
and a separate mesh stage. Its Mantaflow integration reconstructs a particle
level set and extracts a mesh with Marching Cubes. Niagara's documented 3D FLIP
path instead splats a grid and ray-marches its surface: a useful alternative,
but not a source of actual triangles.

## Proposed Responsibilities

1. A new GPU-only `SurfaceRenderer`, separate from `MeshRenderer` (which instances
   supplied geometry per particle), selects render-time particles by tags.
2. A private reconstruction helper uses the managed spatial grid for neighbor
   queries. It does not change FLIP pressure, occupancy, particle spacing, or
   movement. Ordinary non-FLIP particles can also supply the surface.
3. Reconstruct a scalar field from particle positions and radii, with an
   independently controlled voxel size aligned to the query grid's origin.
   Do not interpret FLIP's packed velocity-support occupancy as a surface SDF.
4. Use Surface Nets: classify crossing cells, place one vertex per crossing
   cell, connect neighboring cells, and triangulate the resulting quads.
5. Write positions, gradient normals, particle-weighted colors, indices, and
   indirect draw counts on GPU. Do not read mesh counts/vertices back each frame.
6. Reuse capacity-limited buffers. Expose memory/triangle-budget diagnostics and
   overflow counts. Include halo samples and consistent edge ownership so brick
   boundaries do not crack. Grid changes must invalidate all dependent resources.
7. Render using normal surface materials with depth, lighting, and shadows.
   GPU-only mode should reject unsupported execution, as the fluid modules do.

## Proposed Initial Controls

`tags`, `voxelSize`, `particleRadiusScale`, `isoLevel`, `smoothingIterations`,
`smoothingStrength`, material, shadow flags, and a surface memory budget.
These are proposed names, subject to implementation review. Rendering groups
follow renderer/tag composition rather than creating a second fluid solver.

Start with isotropic reconstruction and conservative smoothing. Plain Laplacian
smoothing shrinks surfaces; measure volume loss and small-drop preservation
before adopting an aggressive default. Review permissively licensed existing
Surface Nets implementations and tests before choosing the kernel. No Obi
proprietary implementation or Blender GPL integration code should be copied.

## First-Pass Acceptance Criteria

Merge two overlapping drops without seams; retain isolated drops above the
voxel-size limit; render the teapot fill, spout, and overflow from multiple
angles; preserve per-particle colors and transient scale; remain stable after
emission stops; respect tag isolation and resource cleanup. Record GPU time,
buffer occupancy, overflow, normal validity, and frame-to-frame surface motion.
Use desktop/mobile WebGPU screenshots and numeric checks, not only a full pot.

Advanced anisotropic kernels, foam/spray generation, refraction, thickness-based
absorption, and CPU mesh export are explicitly outside the first pass. Producing
triangles does not by itself produce convincing transparent water optics.

## Pre-Surface Simulation Checks

The teapot has separate geometric, particle-radius, solver-cell, and baked
collider-field resolutions. A geometrically open tube may still be closed in
the pressure grid. Smaller particles reduce swept-contact radius and requested
spacing, but do not refine either grid. Higher solver resolution alone does not
refine the collider bake. Particle scale also changes represented liquid volume,
so shrinking particles without increasing emission can stop the pot filling.

Use `node tests/visual/teapot-spout-review.mjs /tmp/rzmps-teapot-spout` to compare
centerline clearance, swept GPU contacts at two radii, and solid masks at
64/128 solver resolution and 48/96 collider-bake resolution. This diagnostic
does not change preset settings. Review pressure connectivity and actual water
level before weakening collision or increasing emission to force a result.

The solid-mask conversion currently treats any positive interpolated collider
influence as occupied. That can dilate a coarse baked mask into narrow channels.
A future correction should test a documented occupancy threshold or conservative
subcell boundary treatment against both thin-wall containment and open pipes.
Do not blindly change it as part of a renderer feature.

### Spout Diagnostic Findings

The current OBJ has a traversable sampled centerline. Closest-triangle clearance
decreases from about 0.224 to 0.073 simulation units along it. GPU capsule sweeps
at both the preset radius (0.0425) and a smaller radius (0.025) reported no
contact on the sampled interior segments. These probes do not cover every
possible path or prove a complete spill through the outlet.

The existing asymmetric requested bounds are cubified around their center
before origin-centering. `[-3,-1,-3]` through `[3,4,3]` therefore extends to y=4.5
and rounds to a 16-unit domain, giving 0.25-unit cells at resolution 64. This
is larger than needed for the pot and coarser than the narrow throat.

Measured solid flags along seven centerline samples:

| Domain Side | Grid | Collider Bake | Cell Size | Occupied Samples |
| --- | --- | --- | --- | --- |
| 16 | 64 | 48 | 0.25 | 3/7 |
| 16 | 128 | 48 | 0.125 | 3/7 |
| 16 | 128 | 96 | 0.125 | 2/7 |
| 8 | 64 | 96 | 0.125 | 2/7 |
| 8 | 128 | 96 | 0.0625 | 0/7 |

Artifacts: `/tmp/rzmps-teapot-spout/metrics.json`. The diagnostic changes only
its in-memory test instance; production preset bounds/quality remain unchanged.
Before changing the preset, run a filling/spilling comparison with compact
origin-centered initial bounds (retain the 16-unit growth cap), grid 128,
collider bake 96, and unchanged particles. Verify connected free cells and
actual outlet flow, measure the eightfold dense-grid cost of doubling resolution,
and keep a containment/packing regression. Only then consider particle size.
Smaller particles alone cannot repair a blocked pressure grid.

Two additional checks belong in that corrective pass. First, FLIP currently
distinguishes marker-containing pressure cells from velocity-only support;
refining far below marker spacing can fragment that pressure domain, so measure
connectivity rather than assuming finer always behaves better. Second, the
collider field is baked on CPU: increasing bake resolution also increases cold
startup cost. Measure bake time separately from steady-state GPU frame time.

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
