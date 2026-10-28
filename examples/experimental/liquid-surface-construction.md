# Liquid Surface Construction Plan

The first experimental GPU `SurfaceRenderer` is implemented. See [the workbench](README.md) for current controls
and [the liquid quality notes](liquid-quality-and-whitewater.md) for resolution and optimization findings.

## Implemented First Pass

`SurfaceRenderer` reconstructs a compact-support isotropic density/color field
from render-time GPU particles, then extracts indexed Surface Nets triangles.
It is a renderer, not a FLIP module: ordinary GPU particles work too. The FLIP
demo now uses it instead of sprites. Particle motion, pressure and collider
occupancy are unchanged. No Obi proprietary or Blender GPL code was copied;
the extraction kernels are written in TSL. The MIT [Surface Nets reference][surface-nets]
was reviewed alongside the algorithm description.

- Reconstruction shares `SparseVolumeGrid`/`SpatialGrid` with gas, including
  compact active-brick dispatch. Unlike gas, it retains no advected field:
  current render particles determine every frame's requested pages.
- `ParticleSpatialGrid` supplies exact-radius neighbor queries. A private GPU
  projection into its canonical particle layout indexes transient/child output
  without changing the simulation's grid or positions. This extra GPU view uses
  a full particle record for compatibility, not CPU readback or a new hash engine.
  Generalizing the query helper to compact render storage can remove that copy
  later if profiling warrants it.
- Eight-cell bricks include allocation support for adjacent corner samples and
  dual-cell connections. One vertex is stored per crossing cell; each crossing
  primal edge owns one quad. Unsmoothed normals use the reconstructed field gradient.
- Indirect GPU index counts select the drawn triangles. Ordinary updates never
  read mesh counts/vertices back. `readSurfaceDiagnostics()` explicitly reads
  counts, budget overflow, clipped-particle counts and effective bounds.
- `voxelSize` (default 0.0625), `particleRadiusScale` (2.4), `isoLevel` (0.2),
  `maxActiveBricks` (512) and `maxTriangles` (131072) are independent controls.
  The material, shadow flags, particle-color toggle, tags, children and query-grid
  options use renderer conventions. Both GUI paths and serialization are wired.
- `smoothingIterations` (default 3, integer 0..16) and `smoothingStrength`
  (default 1, range 0..1) apply paired Taubin Laplacian passes to connected
  quad-edge neighbors on the GPU. A reverse pass reduces the shrinkage of plain
  averaging; this is not exact volume conservation. Vertices stay in their
  original dual cells, disconnected drops are not connected, and topology does
  not change. Final normals are rebuilt from area-weighted incident triangles;
  dye is re-sampled from the reconstructed field at the smoothed position.
  Zero iterations or strength preserves the original reconstruction.
- `bounds` is a reconstruction region in system space, not a physical wall.
  It defaults to [-4,4] per axis. Its minimum snaps down to the voxel lattice;
  coverage expands to a cube with a power-of-two cell count, at least eight and
  at most 512 per axis. World voxel size remains fixed. This is intentionally a
  bounded first pass rather than automatic whole-world surface coverage.
  A particle whose full kernel plus the final sample margin is outside effective
  coverage is omitted and reported as clipped, rather than generating a cut shell.
  Increase bounds or voxel size explicitly when needed.
- Budget overflow is observable but does not automatically grow GPU allocations.
  Missing neighboring vertices are never referenced, and index counts clamp to
  capacity. Overflow may therefore leave holes: raise the affected budget before
  judging surface continuity. Buffer limits and GPU memory still apply.

The kernel is `alpha * max(1 - squaredDistance / squaredRadius, 0)^3`, with
radius equal to half the largest absolute render scale times `particleRadiusScale`.
Zero alpha/size contributes nothing. Alpha changes reconstruction density, not
per-vertex transparency. Material opacity remains a separate global control.
Isolated drops below voxel resolution can disappear. Query-grid subdivisions
affect query cost, not reconstruction voxel size; unbounded queries remain exact.
Explicit positive `maxQuerySteps` trades away reconstruction accuracy.

### Particle Colors And Custom Materials

Color is accumulated alongside density using the same positive kernel weights,
interpolated at edge crossings, normalized by crossing density and averaged at
the Surface Nets vertex (or re-sampled after smoothing). This transfers particle colors in linear RGB and blends
them where particles overlap. Vertex attributes are position, surface normal
and RGBA color (alpha one). Color detail below the reconstruction scale is averaged;
vertex colors cannot preserve an arbitrarily fine discontinuous dye pattern.

The renderer clones a supplied material and owns/disposes the clone. The public
`material` property edits that owned material; assigning another material clones
it too. The original shared input is never changed or disposed. `particleColors`
defaults to true and enables its `vertexColors` path: standard Three.js surface
materials multiply particle color by their base color, textures and lighting.
Use a white base color to retain the particle palette. Turning the flag off
leaves color data available but disables this automatic material modulation.

Custom node materials using Three's normal diffuse-color path also receive vertex
colors. A custom `fragmentNode`, output shader or other replacement that bypasses
that path must explicitly sample the `color` attribute (for example via TSL
`attribute('color', 'vec4')` in a varying) and combine it with its shading. The
renderer does not replace a user's color/fragment graph. Raw GLSL ShaderMaterial
is subject to Three's native WebGPU material limitations, not automatically
translated by this renderer. UVs, dye textures and a dedicated material-node API
are not generated in this pass. Discuss those separately if custom materials
need sharper-than-vertex color detail or a prescribed blend contract.
GUI code export supports ordinary Three.js material parameters, not arbitrary
custom shader/node graphs; keep those graphs in authored application code.

### Water Material

The FLIP preset passes an ordinary `THREE.MeshPhysicalMaterial` with transmission
0.9, roughness 0.055, IOR 1.333, thickness 0.3 and pale-blue attenuation over
distance 3. The teapot scene uses the existing studio HDR environment for
reflections. These are rendering controls, not solver viscosity or density.
The renderer injects no shader code, even for custom materials.

Three.js handles physical-material lighting, transmission and depth testing.
Thickness is a constant approximation; there is no measured front/back fluid
depth or bespoke screen-space water pass. Standard transmission does not
refract all transparent objects, including the translucent display teapot.
For clear water retain alpha one and use transmission, not generic alpha blending.

### Verification And Remaining Scope

`node tests/visual/surface.test.mjs` exercises merged/separate colored drops,
brick-edge continuity, triangle winding, finite unit normals, tags, source
removal/reuse, alpha/scale/transient inputs, children, clipping, triangle budgets,
material ownership, GUI/serialization and resource teardown. Smoothing checks
cover disabled equivalence, disconnected/small-drop preservation, finite unit
normals, triangle winding, budgeted topology and buffer teardown. The two-drop case
has 1804 triangles, one connected component, no open edges and a red/blue blended
join on an eight-storage-buffer device. Desktop/mobile captures are written to
`/tmp/rzmps-surface-desktop.png` and `/tmp/rzmps-surface-mobile.png`.

`node tests/visual/liquid-surface-review.mjs /tmp/rzmps-liquid-surface` captures
the actual teapot fill after emission stops and records surface/update GPU timing
and budget occupancy. These checks do not establish a physically improved spout
or fix the pre-surface simulation findings below.

Before smoothing and transmission, the first 16-second teapot run on Chromium / Apple Metal 3 produced 12,664 /
28,204 / 25,468 triangles at 2 / 8 / 16 seconds. Resident bricks were 203 / 178 /
188 of 512, with zero overflow and zero clipped particles at each checkpoint.
The last thirty updates measured a median 1.02 ms of surface-stage GPU dispatch
work and 5.84 ms for the whole update. These timestamp measurements exclude
rasterization and are not an interactive FPS guarantee. Desktop/mobile captures
show retained liquid after the 14-second emitter duration. The isotropic surface
was visibly bumpy. Inflated rendering
kernels may also extend beyond collider geometry even when marker collisions
are correct; the surface does not currently clip against collider fields.

Anisotropic kernels, automatic reconstruction bounds,
manifold disambiguation of pathological Surface Nets saddle configurations,
measured-thickness passes, UV generation and CPU mesh export remain deferred.
The initial API is deliberately smaller than the proposed complete controls below.

With four smoothing pairs, the two-drop regression retained its 1,804 triangles
and closed topology; mean squared adjacent-normal difference fell from 0.03692
to 0.03444 and enclosed volume changed from 0.27210 to 0.27300 (about +0.33%).
The smoothed-water teapot review produced 12,648 / 27,524 / 25,720 triangles
at 2 / 8 / 16 seconds, with no clipping or budget overflow. Its last thirty
updates measured median surface compute 1.19 ms and whole-update compute 6.05 ms.
These exclude rasterization, transmission and environment preparation costs.
The review gives repeated dispatches unique timestamp keys so smoothing and
pressure iterations are each counted rather than overwriting their query entries.
Captures and metrics are in `/tmp/rzmps-liquid-smoothed-water`.
Desktop/mobile canvas checks found 27,096 / 6,292 water-colored pixels, and an
additional simulation step changed mesh positions. Counts vary with particle
randomness and GPU scheduling; these are observations, not exact scene snapshots.

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
[surface-nets]: https://github.com/mikolalysenko/isosurface/blob/master/lib/surfacenets.js
