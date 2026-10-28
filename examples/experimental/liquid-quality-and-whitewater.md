# Liquid Quality, Performance And Secondary Effects

Investigation date: October 28, 2026. This is a discussion plan, not a claim that
APIC, anisotropic meshing, reseeding, or whitewater are implemented.

## Demo And Investigation Baseline

- The interactive FLIP preset uses 3+4 subdivisions (128 cells per axis), a
  32,000-particle cap and continuous emission instead of its old 14-second duration.
  At 450 particles/second and the unchanged 60-second lifetime, steady population is about
  27,000, below the cap. The old preset stopped because of duration, not its
  8,000-particle budget: it emitted only about 6,300 particles.
- Particle diameter remains 0.085, physical spacing multiplier 1.1, PIC fraction
  0.08, surface voxel size 0.0625, and four paired surface smoothing iterations.
  Raising the cap alone does not increase sampling density or reduce chunkiness.
- Scene Settings has manual Tip (Degrees), Automatic Tipping, Automatic Tip Angle
  and Tip Period (Seconds). Automatic tipping defaults on, at 45 degrees every ten seconds. Its cycle holds upright
  to fill, tips, pauses to pour, then returns upright. Manual adjustment disables
  automatic tipping. The vessel lifts to clear the floor; emitter and floor stay fixed.
- Fluid particle collision previously put every collider in the static BVH list.
  It now respects SpatialEffect's existing static/transform-dynamic/geometry-dynamic/
  auto policies. The teapot uses transform-dynamic; the floor is static. This is
  essential for visible geometry and physical collision to agree during tipping.

## Original Dense Costs

Run `node tests/visual/liquid-performance-review.mjs`. Results are written to
`/tmp/rzmps-liquid-performance.json`. Chromium native WebGPU on Apple Metal;
800x600 viewport; 900 warmup steps at 60 Hz; medians of the next 30 steps;
6,975 live particles in a controlled 16,000-slot allocation; identical source,
material, mesher, and 28 pressure iterations. The interactive preset reserves
32,000 slots, so its particle-pool overhead can be higher than this controlled comparison.
Repeated dispatches have unique timestamp keys. Rendering includes ordinary
Three.js transmission/shadow passes; compute includes the surface renderer.

| Stage | 2+4 / 64 cubed | 3+4 / 128 cubed |
| --- | ---: | ---: |
| Whole GPU update | 5.81 ms | 23.42 ms |
| Pressure sweeps | 1.52 ms | 11.25 ms |
| Particle-to-grid gather | 0.85 ms | 5.55 ms |
| Other projection work | 0.16 ms | 1.16 ms |
| Before/after face construction | 0.10 ms | 0.67 ms |
| Solid occupancy | 0.03 ms | 0.76 ms |
| External forces | 0.03 ms | 0.36 ms |
| Particle separation/contact correction | 0.40 ms | 0.64 ms |
| Grid-to-particle transfer | 0.14 ms | 0.14 ms |
| Particle query-grid build | 0.03 ms | 0.03 ms |
| Surface reconstruction/smoothing | 1.22 ms | 1.31 ms |
| Other compute, including integration/collision/emission | 1.23 ms | 1.50 ms |
| GPU rendering | 0.27 ms | 0.24 ms |
| CPU submission, excluding GPU waits | 0.70 ms | 0.70 ms |
| Eulerian/face storage measured by typed-array sizes | 24.38 MiB | 193.51 MiB |

Stage medians need not sum to the median total. Storage excludes canonical
particle storage, query hash, surface allocations, textures and browser overhead.
These are stage measurements, not an interactive FPS guarantee. Doubling axis
resolution multiplies cell count by eight; gas's sparse execution advantage does
not currently apply to dense liquid. At 128 cubed, pressure is about 48% and
gathering about 24% of update time. Rasterization is not the present bottleneck.

## Best Optimization Targets

1. **Compact liquid work using the existing shared sparse infrastructure.**
   FLIP queries ParticleSpatialGrid but still dispatches the full dense domain.
   Shared FluidPressureProjection already supports SparseVolumeGrid addressing
   for gas. Reuse that layout and active-brick dispatch for liquid, activating
   marker support, air/pressure neighbors, extrapolation halos and shared faces.
   Do not simply stop processing empty cells: boundary stencils and donor validity
   must remain correct. A fixed-capacity pool can reduce dispatch work before
   changing memory reservation. Preserve cell lattice, cap behavior, and diagnostics.
   The liquid gather is already near the eight-storage-buffer minimum budget:
   adding sparse page metadata may require packing outputs or splitting a stage,
   not merely passing one more independent storage buffer.
2. **Cache static solid occupancy.** Recompute only when domain mapping, collider
   geometry/pose, occupancy settings, or closed-cap policy changes. Tipping must
   invalidate the cache; an upright stationary pot should not pay this every frame.
   This targets roughly 0.76 ms at the tested high quality, not the full bottleneck.
3. **Improve pressure convergence per unit work.** There are 56 full-grid pressure
   dispatches at 28 red/black iterations. Residual-based iteration control and a
   guarded warm start could help; warm starts need invalidation/rescaling when
   timestep, domain or topology changes. A multigrid/preconditioned solve is a
   larger follow-up. Fewer sweeps without residual checks can restore compression.
4. **Optimize source gathering after compaction.** Shared cell/brick workgroup
   caching could reuse neighbor data. A sort library alone will not accelerate
   the pressure solve, and replacing the existing query hash is not justified yet.
5. **Small transfer/memory cleanups.** Liquid only needs current center occupancy
   for transfer validity now that it samples face velocities. Audit remaining
   center-velocity reconstruction and legacy pressure scratch before removing it;
   keep debug/provider contracts explicit. Surface projection into canonical query
   storage and always-built smoothing topology are smaller measured costs.

The baseline investigation did not implement APIC, compact liquid work, a pressure-budget
reduction, or a new foam solver. The corrective follow-up below implements the first
two performance targets. Transform-only collider motion already uses BVH transform
updates; rebuilding triangle geometry per tip is unnecessary.

## Corrective Follow-Up: Compact Liquid Execution

Implemented scope:

- FLIP reuses SparseVolumeGrid's GPU-only particle marking, conservative source
  halos and indirect active-brick lists. ParticleSpatialGrid remains its particle
  neighbor-query implementation; no second particle hash or sort pipeline was added.
- SparseVolumeGrid now supports compact execution against dense cell/face addresses.
  FLIP gathering, forces and the existing matched MAC projection use that path.
  Every active brick includes the existing conservative particle-support halo;
  shared dense face vectors have exactly one writer, including sparse edges and corners.
  Pressure equations, 28 iterations, interpolation, PIC fraction, separation and
  particle spacing are unchanged. This is sparse execution, not sparse field storage.
- FLIP packs gathered current/before values into one allocation to leave room for
  page metadata within WebGPU's minimum eight-storage-buffer binding budget.
- Before rebuilding the list, clear the previous active cells/faces, including
  bricks being retired. New fields receive a full initialization only when created
  or structurally changed. This prevents stale pressure/velocities without scanning
  the entire dense allocation each frame. Indirect buffers are initialized before
  the first empty clearing dispatch.
- Cache dense liquid solid occupancy while collider and domain state is unchanged.
  Invalidate for collider membership/version, transforms, geometry revisions,
  occupancy settings, simulation-space mapping and cap changes. Static and
  transform-dynamic geometry can cache; custom predicates/conditions and auto or
  geometry-dynamic policies remain uncached. Gas's dynamically allocated solid
  pages retain their existing per-step handling.
- No new GUI tuning fields, no lower pressure quality, no changed emission/volume,
  no APIC/reseeding, and no new whitewater subsystem in this corrective pass.

Validation:

- `flip-compact.test.mjs`: identical 512-marker states through one and 30 steps,
  then relocation to another set of bricks. All three compact/dense snapshots
  matched exactly on the tested GPU. Retired-region pressure was zero. Only 8/512
  bricks were active. Stationary/moving/stopped solid dispatch counts were 0/1/0.
- `flip-projection.test.mjs`: synthetic hydrostatic column spanning shared brick
  faces; divergence RMS 0.26667 -> 0.000923, matched-operator error zero and blocked
  wall flux zero after its convergence-test iteration budget.
- Native GPU separation, wall drift, cap policies, 30-second settling/restart,
  gas numerical invariants, sparse gas and teapot tipping checks all passed.
  Settled reference RMS speed was 0.0412 with median rest-spacing ratio 0.9814
  and no heavily compressed pairs. The current demo's pour remained finite, with
  262 sampled spout markers and 51 outlet-floor markers in that run. These counts
  vary with the emitted sample sequence; they are functional checks, not volume guarantees.

Remaining boundaries: dense field memory is deliberately retained; a truly sparse
liquid allocation would be a separate storage/addressing change. The existing
transfer and meshing quality limitations below are not fixed by dispatch compaction.

### Final Follow-Up Timings

Same benchmark hardware, viewport, warmup, particle capacity/population and pressure
budget as the dense baseline above; medians from a new run. Emission samples can
differ between runs, so compare these stage measurements alongside the deterministic
compact/dense correctness test, not as proof of identical mesh topology.

| Stage | 64 cubed compact | 128 cubed compact |
| --- | ---: | ---: |
| Whole GPU update | 4.18 ms | 5.66 ms |
| Pressure sweeps | 0.63 ms | 0.88 ms |
| Particle-to-grid gather | 0.43 ms | 0.71 ms |
| Other projection work | 0.063 ms | 0.112 ms |
| Before/after face construction | 0.047 ms | 0.083 ms |
| Active cell clearing | 0.011 ms | 0.035 ms |
| Active face clearing | 0.013 ms | 0.030 ms |
| Work-list build and scheduling | 0.060 ms | 0.203 ms |
| External forces | 0.010 ms | 0.027 ms |
| Particle separation/contact correction | 0.39 ms | 0.62 ms |
| Grid-to-particle transfer | 0.12 ms | 0.14 ms |
| Surface reconstruction/smoothing | 1.19 ms | 1.29 ms |
| Other compute, including integration/collision/emission | 1.12 ms | 1.49 ms |
| GPU rendering | 0.28 ms | 0.26 ms |
| CPU submission, excluding GPU waits | 0.80 ms | 0.80 ms |
| Active/logical liquid bricks | 16/64 | 40/512 |
| Eulerian/face storage | 24.38 MiB | 193.51 MiB |

Stationary solid occupancy had no steady-state dispatch. GPU update improved
about 1.39x at 64 cubed and 4.14x at 128 cubed relative to the original dense
baseline. The intermediate compact version still cleared full allocations and
cost 7.43 ms at 128 cubed; clearing retired work before list rebuild reduced that
to 5.66 ms. Neither number is a general interactive FPS guarantee.

Endpoint reached for this pass. A useful next discussion is quality, not another
unmeasured pressure-budget reduction: matched marker/grid refinement, direct-face
transfer versus APIC, and independent surface reconstruction controls. If further
performance work is selected, remaining measured costs include surface generation,
particle integration/collision/emission and separation; pressure is no longer the
dominant stage in this fixture. Sparse storage would primarily address memory.

### Tipping Verification

`teapot-tipping.test.mjs` checks manual angle, automatic hold/return, disabling
motion, matched display/collider matrices, a fixed emitter, floor clearance,
finite particle state, mobile water pixels and cleanup. In a native-GPU pour run,
the sampled spout held up to 273 liquid markers and 61 markers reached the floor
near the outlet. The BVH recorded 288 transform updates, with no additional full
build, topology rebuild or geometry refit. Captures are in
`/tmp/rzmps-teapot-tipped.png` and `/tmp/rzmps-teapot-tipped-mobile.png`.
`teapot-gui.test.mjs` exercises the real Scene Settings slider and checkbox.

## Why It Can Still Look Chunky Or Viscous

There is no explicit viscosity solve in FLIPSimulation. Apparent viscosity can
come from transfer dissipation and insufficient sampling, while lumpy highlights
can come from reconstruction rather than motion.

- **Transfer:** the implementation gathers cell-center velocities using a cone
  kernel, averages centers onto faces, and mixes 8% PIC into FLIP. That intermediate
  averaging plus repeated PIC mixing removes detail. Lower PIC is a useful A/B test,
  but may bring back noise; it is not equivalent to setting a physical viscosity.
- **Sampling:** at eight-unit bounds, 64 cells gives h=0.125 and 128 gives h=0.0625.
  Rest spacing is currently 0.085*1.1=0.0935. The simple spacing-cube estimate is
  about 2.4 markers/cell at the first quality but only 0.30 at the second. Actual
  packing is not a cubic lattice, but the eightfold change is real. More cells
  without smaller/more numerous markers can leave pressure classification sparse.
- **Matched particle refinement:** halving particle scale/rest spacing requires
  about eight times as many particles to retain the same liquid volume, and about
  eight times the source rate to retain the same volumetric flow. A higher maximum
  alone does neither. This should be a measured quality option, not an unannounced
  change to emitted volume or a promise of free detail.
- **Surface:** the mesher's isotropic support radius is 0.102 at current size/radius
  scale, independently of solver h. Its voxel size also stays 0.0625. More solver
  cells cannot remove these reconstruction scales. More smoothing can hide bumps
  but cannot invent thin sheets or correctly separate close surfaces.
- **Boundaries:** binary cell solids/free surfaces remain stair-stepped. Teapot
  occupancy uses a 48-cubed local baked field; this is a third independent quality
  limit, especially in the narrow spout. Mesh collision itself still uses the BVH.
- **Moving walls:** the follow-up below adds rigid relative-motion particle sweeps.
  The grid still treats solid-face velocity as zero rather than prescribing the
  rigid-body boundary velocity. Particle CCD and a moving pressure boundary are
  separate features; this is not a complete moving-boundary fluid solver.
- **Shading:** strongly dyed particle colors and constant material thickness can
  read as gel independently of viscosity. Compare unlit/normal/wireframe views and
  a neutral water palette before attributing every highlight lump to the solver.

### Comparison Software

- [Blender liquid settings][blender-settings] separates FLIP/APIC transfer and FLIP
  ratio. [Its mesh controls][blender-mesh] separate mesh amplification, particle
  radius and positive/negative smoothing. Its [Python API][blender-api] also exposes fractional
  obstacle boundaries. These are different remedies for motion versus surface shape.
  Our `picRatio` uses the opposite blend direction to Blender's FLIP ratio:
  `picRatio=0.08` corresponds to a 0.92 FLIP blend, not 0.08. Matching that blend
  does not imply identical transfers, collision resolution, or visual behavior.
- [Houdini FLIP][houdini] separates FLIP/PIC smoothing, APIC, positional separation,
  and reseeding. Reseeding fills under-sampled cells and prunes crowded ones, but
  must be controlled to avoid surface noise or volume changes. It is not cosmetic
  renderer-child generation.
- [Obi's realtime mesher][obi-mesh] exposes voxel size, isosurface offset, gradient
  descent, smoothing and chunk memory independently of fluid physics. Its Surface
  Nets approach is close to our renderer; field-guided vertex descent is a smaller
  next step than a new solver. Do not confuse solver blueprint anisotropy with an
  automatically available anisotropic fluid mesher feature.
- [Niagara's overview][niagara] describes hybrid FLIP and particle-to-grid surface
  rendering; moving collision velocity is part of its boundary treatment. Public
  overview docs do not establish every template's implementation or performance.
- [Unity HDRP water][unity-water] explicitly focuses on water-surface deformation,
  not a general pouring-liquid solver. Obi is the relevant Unity realtime meshing/
  particle comparison; HDRP foam/decal controls are useful shading inspiration only.
- [APIC's original paper][apic] targets PIC transfer information loss while avoiding
  FLIP noise. It needs per-particle affine data and direct consistent transfers;
  it is not just an enum rename or a smaller PIC coefficient.

Recommended order for discussion: compact dense liquid work; matched particle/grid
sampling experiment; direct face P2G plus controlled PIC/APIC comparison; sub-cell
liquid/obstacle boundaries; surface field descent or bounded anisotropic kernels.
Keep physics, marker resolution, and surface reconstruction independently tunable.

## Spray, Foam And Bubbles As Subsystems

[Blender][blender-particles] treats spray, surface foam and submerged bubbles as
secondary particle systems with independent lifetimes and buoyancy/drag. They are
not part of its primary liquid mesh. [Houdini whitewater][whitewater] sources from
acceleration, surface curvature and vorticity. [Obi foam][obi-foam] uses a velocity/
vorticity-driven potential, emission rate, age, drag and buoyancy, with optional
foam density control. This supports our existing module/subsystem division.

The source-selection API is now implemented; the actual secondary effects remain future work:

1. `shouldEmitGPU` now accompanies the existing subsystem `shouldEmit` callback. This
   is sufficient for basic spray eligibility: speed, acceleration and age already
   belong to the source particle. A neighborhood/isolation condition can use
   ParticleSpatialGrid; it does not require a new liquid-field sampler. Retain the
   existing subsystem emission, inheritance, lifetime and renderer mechanisms.
   There is no need to require a WhitewaterSource module for simple predicates.
2. The hook runs for continuous and event-driven GPU emission, with support reporting,
   function-identity cache invalidation and lifecycle cleanup. CPU callbacks are
   allowed on the GPU-native path when a counterpart is supplied. A boolean false
   still disables emission. CPU mode uses the CPU callback only. Event predicates
   inspect captured source state, not a potentially recycled live slot. A separate
   GPU pass writes one eligibility uint per source slot/event, shared across child
   emitters; query bindings do not accumulate in the birth shaders. Requested
   ParticleSpatialGrid neighborhoods are rebuilt after parent motion/collision and
   describe current live particles, not historical event neighborhoods.
3. Add fluid sampling only when a feature needs information absent from the
   particle: Eulerian velocity for following the liquid, depth/occupancy for
   bubbles, a surface constraint for foam, or field-derived curl/curvature for
   sophisticated source selection. Source velocity inheritance alone does not
   continuously advect secondary particles after emission. Keep sampling on the
   simulation/provider, independent of SurfaceRenderer and renderer children;
   use existing tag-filtered module lookup when discovering providers.
4. Spray uses inherited fluid velocity, gravity, atmospheric drag and optional
   collision. Foam follows sampled velocity and stays near the surface. Bubbles
   use velocity drag plus buoyancy. Density/depth thresholds with hysteresis can
   switch modes; each subsystem has independent population/rate/lifetime budgets.
5. Render small droplets/sprites or ellipsoids separately, exclude them from the
   primary surface field, and use existing age/color/scale modules. This is normally
   one-way visual coupling, not extra mass in the incompressibility solve. An optional
   foam-potential surface attribute/mask can later supplement discrete whitewater.

Collision-triggered splash subsystems are a useful existing approximation, but do
not detect breaking sheets or trapped air. Whitewater improves visual scale and
motion cues; it should not conceal a broken liquid solve or replace bulk meshing.

### Implemented Spray Factory

```js
parent.addSubSystem(spray, {
  emitContinuous: true,
  inheritVelocity: 1,
  inheritLifetime: 0,
  shouldEmitGPU: FLIPSimulation.SprayCondition({
    minimumSpeed: 1,
    minimumAge: 0.05,
    maximumNeighbors: 8,
    neighborRadius: 2,
  }),
});
```

Both systems must be configured for GPU processing. The factory does not construct
the child, its emitters, textures or renderer. The FLIP demo now installs a separate
1,500-slot spray child using the uploaded `spray_alpha.png`, inherited velocity/color,
short lifetimes and transient scale/alpha fading. Its source gate requires speed 1.5,
age 0.1 seconds and at most six neighbors, with source ratio 0.15 and rate eight per second.
Foam remains deferred.
It is a speed/age/isolation gate, inspired by energy and air-entrainment source
controls, not a vorticity/curvature estimator or a complete Obi/Blender whitewater
algorithm. Speed includes the particle speed multiplier; minimum age is seconds
(converted from the stored millisecond age). Neighbor radius multiplies the largest
absolute source scale. Count excludes the exact slot/generation identity but counts
other live parent particles regardless of tags. `maximumNeighbors: null` disables
the query and its managed grid. Rate, source ratio, lifetime and velocity inheritance
remain ordinary subsystem settings. Options are captured at factory creation;
create/reassign a new predicate to change these thresholds.

The function's `spatialGridOptions` declares its query dependency. Preserve it if
wrapping/composing the returned function; a wrapper is a new predicate. There is no
requirement for an actual FLIP module on the parent, nor a new fluid-field sampler.

## Bounds, Pressure Support And Moving Walls Follow-Up

### Mesh Holes

The mesher's independent default eight-unit region was smaller than the demo's
sixteen-unit simulation cap. Fluid could spill into space the solver supported but
the renderer omitted. The demo now explicitly reconstructs [-8,8] with unchanged
0.0625 voxels, a 2,048-brick budget and a 262,144-triangle budget. Library defaults
remain unchanged; explicit reconstruction limits can still clip particles, and
budget exhaustion still needs to be handled through the diagnostics API.

An untipped 45-second baseline stayed under its original budgets, so overflow does
not explain every reported visual defect. `surface-bricks.test.mjs` translates a
64-particle blob across brick faces/edges/corners and reuses slots: all five samples
had identical triangle counts, one connected component and zero open edges, including
smoothing. The moderate/steep-angle teapot samples below also had zero open edges,
zero clipping and no exhausted budgets after expanding coverage.

This does not establish that every visual hole is fixed. The pouring mesh did have
nonmanifold edges (88 and 434 in the sampled runs), consistent with the one-vertex-
per-cell Surface Nets ambiguity at thin connections. Resolving that requires a
topology/ambiguity policy, not assuming a missing brick. No general brick-stitching
defect was reproduced in this pass; keep the diagnostic distinct from that hypothesis.

### Spout And Pressure Support

`teapot-spout-clearance-review.mjs` samples hollow cross-sections against the actual triangle
BVH. Maximum world-space clearance drops from about 0.186 at local x=2 to 0.084 at
x=3, versus a 0.0425 particle radius plus 0.02 contact margin. This demonstrates
room at those sampled sections, not a continuous clearance certificate through the
entire bent outlet. The spout is narrow and its baked 48-cubed obstacle field is
another independent sampling limit; the model was not widened by assumption.

The old fine-grid classification did contain an actual pressure-support error:
after filling, about 2,100 of 5,500 supported non-solid cells with reconstructed
volume fraction above 0.75 were classified as air merely because no marker center
landed inside that exact cell. Air has zero pressure, so these gaps interrupt
pressure transmission through the liquid. Gathering now also marks reconstructed
volume fraction >=0.5 as liquid, while retaining marker-containing cells. The same
diagnostic subsequently found zero such artificial-air cells. This reuses the
existing normalized cone-kernel volume estimate; it is independent of render isoLevel.

The final moderate/steep-angle diagnostic (900 fill steps, stop emission, 480 pour
steps) observed peak spout/outlet-region counts of 11/7 at 35 degrees and 77/260 at
60 degrees, without GPU validation errors. These region counts are not mass flux:
body-rim spill and stochastic source samples can also enter the measured regions.
Moderate-angle pouring remains weak, so do not call this a complete hydrostatic fix.
Pressure convergence at 28 iterations, fractional free/solid boundaries and outlet
field resolution are candidates for the next diagnostic, before more geometry changes.

### Efficient Rigid Wall Sweeps

- ThreeGPUCollisionBackend optionally retains previous packed transforms through
  `sweptMotion: true` and exposes `queryMovingCapsule`; ordinary queries remain
  current-pose queries. No triangle copy, second BVH or CPU particle readback is added.
- FLIP enables this on its owned backend and runs a separate correction pass only
  while transforms move. Positions are swept relative to the old/current wall pose,
  contacts are carried to the current pose and bounded normal wall momentum is
  transferred. Rebuild the particle hash before P2G reads the corrected positions.
- Motion history is captured once per system step, not overwritten by the dependent
  Collision modules' repeated prepare calls. Membership/geometry changes reset history;
  a following stationary step expires motion. Identical matrices skip quaternion
  decomposition to avoid false motion from roundoff.
- Swept broadphase padding prevents the current-pose TLAS from rejecting walls that
  crossed a particle and ended elsewhere. Rotation uses a conservative chord-error
  allowance; up to two current-pose depenetration queries resolve padded contacts.
  The history is one small additional storage binding in the motion pass only.
- Native tests cover a translating thin wall crossing a stationary particle, a
  90-degree rotation, same-step history preservation/expiry and FLIP integration.
  Rigid movement updates transforms without geometry refits or full triangle rebuilds.
- This is not exact arbitrary-angular-motion CCD, deforming-triangle CCD, or moving
  pressure-boundary velocity. Large rotations can over-correct conservatively, and
  the normal momentum transfer respects the fluid velocity safety limit. Smaller
  timesteps/rate-limited scene motion remain preferable for violent motion.

The demo now moves toward the requested manual/automatic angle at a bounded rate
(default 30 degrees/second; Scene Settings exposes Tip Speed). Slider changes no
longer teleport the collider. This improves presentation and reduces rotational
approximation error; it is not used instead of the new collision sweep.

`moving-wall-performance-review.mjs` measured the new pass on native Chromium/Apple
Metal at 128 cubed, 6,750 particles after 900 warmup steps, then 40 stationary and
40 tipping steps (15 degrees/second, medians of the last 30 in each phase).
The motion pass cost 0 ms stationary and 0.925 ms moving; solid occupancy cost
0 / 0.207 ms. Whole compute, including the expanded mesher and corrected pressure
support, was 9.51 / 10.49 ms. CPU submission was 0.9 / 1.0 ms. The backend recorded
40 transform updates and no additional full builds, refits or topology rebuilds.
These are separate stage medians, not additive guarantees or an FPS promise.

## Surface Foam: Separate From Airborne Spray

Foam can be rendered as a material change on the liquid, as surface-following
secondary particles, or both. It is not necessarily a different mesh, nor simply
"moving water is white": fast laminar flow can be clear, while foam can persist
after the motion that generated it has stopped.

### Established Approaches

- [Obi's foam generator][obi-foam] accumulates an air-entrainment potential using
  velocity and vorticity ranges, with independent generation and decay rates.
  That potential drives secondary-particle emission and a diffuse surface map.
  [Its surface mesher][obi-mesh] transfers particle colors to mesh vertices;
  its rendering pass separately controls surface reconstruction and shading.
  This is the closest match to our particle-carried liquid and custom-material API.
- [Houdini's whitewater solver][houdini-foam] uses a surface-depth band and fluid
  velocity to keep foam near the surface. Airborne spray is ballistic and submerged
  bubbles have buoyancy. Density control, preservation and erosion allow foam
  clumps to persist and break apart. Foam is not restricted to a shader effect.
- [Blender's secondary particles][blender-particles] distinguish spray, foam and
  bubbles. Wave-crest, trapped-air and kinetic-energy potentials are source controls,
  rather than a universal roughness-by-speed rule. Its secondary simulation should
  not be described as an automatic foam-material implementation on the liquid mesh.
- [Unity HDRP][unity-foam] distinguishes simulation-generated foam on water surfaces
  from local foam introduced by water decals, such as wakes and impacts. Its
  surface-water model is not a pouring FLIP solver; the transferable idea is an
  independently evolving foam mask, not its ocean/wave source algorithm.

### Proposed Library Design, Not Implemented

1. Keep a persistent scalar foam potential on liquid particles, with bounded
   production from local velocity differences/curl, acceleration and a surface
   eligibility measure. Absolute speed can gate production but must not be the
   sole definition of turbulence. Thresholds, production rate and lifetime/decay
   remain independent. Integrate rates in seconds so results do not depend on FPS.
   Particle identity/generation changes and clear/reset must initialize the state.
2. Reconstruct a separate `foam` vertex attribute with the same normalized particle
   kernel used for surface color. Preserve actual particle color; do not overwrite
   dye with white or overload color alpha. Interpolate the attribute during surface
   construction and resample it after smoothing, independently of sparse slot reuse.
3. A material can use `foam` to blend toward a pale diffuse tint, lower transmission
   and higher roughness. A supplied texture/noise can break the mask into bubbles;
   optional micro-normal detail should be foam-weighted, not a global perturbation
   of the water. Apply it in surface/world coordinates, ideally advected, to avoid
   screen-space swimming. Noise supplies appearance, not the production signal.
4. Custom materials explicitly consume the attribute. Do not inject arbitrary GLSL
   into user shaders. Provide a documented TSL material example or helper separately
   from the solver; retain ordinary built-in materials when foam shading is unused.
5. Surface-following subsystem particles can add thickness, silhouettes and detached
   patches. They need liquid velocity and a surface constraint, unlike basic spray.
   One potential can feed both mesh shading and `shouldEmitGPU`, avoiding two unrelated
   source definitions. Detailed density preservation and bubble dynamics are later work.

A bounded first foam pass would implement particle potential, surface-attribute
transfer and one opt-in material example, with reset, constant-speed/low-curl and
frame-rate tests. It would not introduce a new whitewater solver or require textures
before the data path can be tested. The proposed production/shading mapping is our
design recommendation, not a claim of parameter equivalence with the cited tools.

[blender-settings]: https://docs.blender.org/manual/en/4.4/physics/fluid/type/domain/settings.html
[blender-api]: https://docs.blender.org/api/main/bpy.types.FluidDomainSettings.html
[blender-mesh]: https://docs.blender.org/manual/en/3.6/physics/fluid/type/domain/liquid/mesh.html
[blender-particles]: https://docs.blender.org/manual/en/3.6/physics/fluid/type/domain/liquid/particles.html
[houdini]: https://www.sidefx.com/docs/houdini/nodes/dop/flipsolver
[obi-mesh]: https://obi.virtualmethodstudio.com/manual/7.1/fluidrendering.html
[niagara]: https://dev.epicgames.com/documentation/en-us/unreal-engine/fluid-simulation-in-unreal-engine---overview
[unity-water]: https://unity.com/blog/engine-platform/new-hdrp-water-system-in-2022-lts-and-2023-1
[apic]: https://www.disneyanimation.com/publications/the-affine-particle-in-cell-method/
[whitewater]: https://www.sidefx.com/docs/houdini/shelf/whitewater.html
[obi-foam]: https://obi.virtualmethodstudio.com/manual/7.1/particleadvection.html
[houdini-foam]: https://www.sidefx.com/docs/houdini/nodes/sop/whitewatersolver.html
[unity-foam]: https://docs.unity3d.com/Packages/com.unity.render-pipelines.high-definition@17.0/manual/introduction-to-foam.html
