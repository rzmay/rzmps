# GPU Processing and Extension Development

RZMPS keeps the same `ParticleSystem` composition on CPU and GPU: emitters create particles,
modules and spatial effects modify them, and renderers display them. Set `gpuProcessing: true`
(the default) and render the system once with an initialized Three.js `WebGPURenderer` to make
GPU simulation eligible. `isGPUProcessingActive` reports the backend actually selected for the
current system; `gpuProcessing` only expresses the requested mode.

```ts
const particles = new ParticleSystem({
  emitters: [emitter],
  modules: [force, color],
  renderers: [sprites],
  gpuProcessing: true,
});

scene.add(particles);
renderer.setAnimationLoop(() => {
  particles.update();
  renderer.render(scene, camera);
});
```

WebGL always uses CPU simulation. A WebGPU system also uses CPU simulation when GPU processing is
disabled, a module lacks a GPU implementation, GPU tag capacity is exceeded, or a CPU-input
renderer is combined with a render-time modifier. Unsupported generic spatial effects are skipped
by the GPU path rather than moving the entire system to CPU. Inspect `supportsGPU`,
`getGPUEmissionSupport()`, `getGPUExecutionSchedule()`, and `isGPUProcessingActive` when composing
custom components. Changing `gpuProcessing` starts a fresh run because CPU objects and GPU buffers
are separate authoritative states.

## Non-Advancing Resource Preparation

An initialized WebGPU renderer can prepare component resources before the first update:

```ts
await renderer.init();
scene.add(particles);
await particles.prepare(renderer);
renderer.render(scene, camera); // Captures the renderer used by subsequent GPU updates.
```

`ParticleSystem.prepare(renderer)` awaits `Module.prepareResources(system, renderer)` on
attached modules, dependents, and registered subsystems. It does not call ordinary module
`prepare(context)`, emit particles, increment age, or advance simulation time. An extension
can allocate storage, bake static geometry, and call Three.js `compileComputeAsync` there.
Custom implementations must preserve that non-advancing contract. Await completion before
updating or disposing the system.

Built-in GPU preparation also captures allocation, emission, collision, integration, transient render
attributes and continuous subsystem eligibility against persistent particle buffers. Parents prepare
before their subsystem emission paths. FLIP prepares full/fresh boundary classification and cold-clear
variants as well as transfer/pressure programs. Preparation on a populated system preserves particle
state, the simulation clock and the event-frame sequence; reset/reprepare uses the replacement bindings.

Preparation is optional: normal updates can still build resources lazily. It does not promise
that every renderer, material, or population-dependent kernel is compiled. CPU/WebGL systems
should use their normal lifecycle instead of calling this WebGPU preparation method.

### Particle capacity growth

`initialCapacity` sets a per-system GPU particle-slot reserve before its first allocation. It defaults
to `ParticleSystem.Settings.GPU_INITIAL_BUFFER_SIZE`, rounds to the usual geometric capacity tier, and
is capped by `maxParticles`. It reserves storage without creating particles:

```ts
const particles = new ParticleSystem({ initialCapacity: 4096, maxParticles: 65536 });
```

Changing it affects the next initial allocation after clear/reset; it does not resize live storage.
The population estimator can still reserve more when required. The demo GUI and code export preserve
this option independently of `maxParticles` and the runtime growth threshold.

`capacityGrowthThreshold` is the only timing control for preparing larger GPU particle storage. It
accepts a fraction greater than zero and at most one, defaults to `1` (100%), and can change at runtime:

```ts
particles.capacityGrowthThreshold = 0.5; // Prepare when estimated demand exceeds half the current slots.
```

The trigger uses the built-in population estimate (including each known live source execution) together
with observed live occupancy, incoming birth batches and reported allocation shortfalls. It compares
that demand with allocated slots multiplied by the threshold, then prepares a geometric capacity tier capped by `maxParticles`. Lowering the threshold
starts preparation earlier; it does not reduce particle counts or change emission settings.

Current particle storage remains active while the replacement allocates and its ordinary particle
allocation/emission/integration programs compile. At an update boundary, GPU copies retain the latest
packed particle fields, the stable particle-state wrapper adopts the prepared backing, and replaced
resources retire after a queue fence. Preparation and adoption do not advance simulation or emission
clocks. Benchmarks expose `capacityEstimatedPopulation`, `capacityPendingSlots`, `capacityAllocationMs`,
`capacityPreparationMs`, `capacityMigrationMs` and `capacitySwapMs` under the GPU simulation owner.

This path prepares particle storage and its generic programs. Module-owned gas programs and renderer-owned
grouping keep their existing binding lifecycle; they do not gain additional preparation hooks. Their
first use after a backing change can still rebuild dependent programs. Asynchronous WebGPU compilation
also performs some JavaScript graph construction on the main thread, so an earlier threshold provides
headroom rather than a guarantee of hitch-free updates.

A module can also override `getSimulationTimestep(requestedDt)` to request a positive maximum
step in seconds. The default is `Infinity`. The system combines requests with its configured
substep interval and includes registered subsystems, keeping emission, modifiers, integration,
and collision on the same clock. This hook must return a CPU number, not a shader node or a
synchronous GPU readback.

`getSimulationSubstepLimit()` optionally limits the number of solver steps recovered in one
incoming interval. Its default is `Infinity`; the system uses the smallest requested limit,
including subsystem requests. Excess time follows the existing time-skipping path rather than
accumulating unbounded catch-up work. Fluid modules expose this through `maxFluidSubsteps`.
A smaller timestep and a work limit serve different purposes: one limits integration error,
the other bounds recovery work after a stall.

## Gas Pressure Solvers

`GasSimulation` recommends `PressureSolver.Auto`, its default. Iterative projection has lower fixed
cost; multigrid targets larger systems with useful coarse levels and stricter pressure goals.
Auto uses an internal measured crossover with hysteresis and retains iterative projection for
ordinary fixed-budget workloads and changing pressure topology. Its thresholds are implementation
policy, not tuning parameters.

```ts
import { GasSimulation, PressureSolver } from '@rzmps/rzmps';

const gas = new GasSimulation({
  pressureSolver: PressureSolver.Auto,
  pressureIterations: 64,
  pressureMinIterations: 2,
  pressureTolerance: 0.1,
  // Optional; most users can leave these at their defaults.
  multigrid: {
    preSmoothing: 2,
    postSmoothing: 4,
    bottomIterations: 12,
  },
});
```

`pressureIterations` is a maximum pressure-work budget shared by the solvers. Iterative spends it
on fine sweeps. Multigrid accounts for estimated coarse smoothing/transfers in fine-cell-equivalent
units, fits complete cycles and spends any short remainder on ordinary smoothing. It does not
expose a cycle count. `pressureMinIterations` and `pressureMaxIterations` bound the same work units.
Without explicit bounds, they follow `pressureIterations`; lower the minimum to permit early
completion. A positive `pressureTolerance` requests a maximum absolute residual goal; zero disables
convergence checks. GPU convergence checks do not synchronize the CPU between cycles.

With neither option supplied, the solver is Auto. Supplying `multigrid: { ... }` without an explicit
`pressureSolver` selects Multigrid. An explicit solver always wins: Iterative ignores the multigrid
execution settings, while Multigrid uses them even for small supported problems. If the budget
cannot fit a complete cycle, its remainder is smoothing. Enum values and their string spellings
(`'Auto'`, `'Iterative'`, `'Multigrid'`) are accepted.

Compatible solver changes retain fine pressure as the warm start. Coarse corrections are transient;
unchanged page/boundary topology can reuse operator metadata while refreshing RHS. Moving/removing
colliders, recycled pages, bounds/quality changes and fractional openings invalidate that metadata.
Auto conservatively uses the iterative reference while the topology settles. It does not promise
that every high-resolution or high-density plume is faster with multigrid.

## Writing CPU and GPU Modules

The CPU callback mutates a JavaScript `Particle`. `modifyGPU` builds a Three.js Shading Language
(TSL) graph over a `GPUParticleLike`; it does not execute once per particle in JavaScript. Work
through [First GPU Module](first-gpu-module.md) for a complete paired implementation and
[First GPU Spatial Effect](first-gpu-spatial-effect.md) for influence, feathering, and custom test
rules.

Reuse ordinary CPU hooks for setup and cleanup. `prepare(context)` runs once before a
module's work on either backend. A function-defined module can request managed acceleration with
`useOctree`/`octreeOptions` for CPU or `useSpatialGrid`/`spatialGridOptions` for GPU; the resulting
`ParticleOctree` is available as `context.octree` on CPU; the GPU context exposes `context.spatialGrid`.
Both callbacks use `(particle, deltaTime, context)`, as do their conditions.
`cleanup()` must call `super.cleanup()` when overridden so managed references are released.

`ParticleSpatialGrid` hashes occupied fine cells; it does not allocate a dense world-volume grid.
Its cached build kernels dispatch over `buffers.count`, not reserved capacity, and are submitted
together. A compact GPU-produced population can pass a `GPUComputeRange` as the fourth argument to
`rebuild(renderer, buffers, buildToken, range)`. The range pairs a uint count node with caller-owned
indirect compute arguments (`ceil(count / 64), 1, 1`), written by an earlier GPU scheduling pass.
No count readback is required. `grid.computeParticles(callback, range)` reuses that dispatch
contract for additional kernels, including exact partial-workgroup guarding. Without a range,
the returned kernel uses the current CPU count; update its `count` when that population changes.
Callbacks decide whether dead slots participate. These kernels require an initialized grid and
must be rebuilt if the grid's underlying particle storage is replaced.

Automatic grids use rectangular, offset domains with cubic cells and brick-aligned faces.
`grid.gridDimensions` and `grid.brickDimensions` describe actual per-axis dimensions; `cellsPerAxis`
is the subdivision reference resolution. Explicit `bounds` opt out of automatic sizing/movement.

`spatialGridOptions.minBounds` and `maxBounds` independently constrain physical dimensions per axis.
For adaptive domains, `maxBounds` limits admission of new brick layers: an expanding face cannot evict
an opposite retained face to make room. The capped domain can be off-origin. Independent delayed
shrinking still removes unused faces; explicit bounds changes remain explicit repositioning requests.
Numbers are cube shortcuts; Vector3 values support anisotropic limits. Defaults are zero/Infinity.
Physical caps fit whole bricks and do not implicitly cap quality. Runtime changes use
`module.setSpatialGridOptions({ maxBounds: new THREE.Vector3(4, 16, 4) })` or `grid.maxBounds = 16`.

Automatic quality uses the longest side of constrained **unquantized** support as its reference floor.
Its power-of-two tier, divided by `2^(brickSubdivisions + cellSubdivisions)`, determines cubic cell width.
Rectangular coverage saves empty space while keeping the enclosing cube's linear-resolution reference;
anisotropy no longer implicitly increases samples along the long axis. `equivalentVolumeSide` remains
a volume diagnostic. A 2 × 2 × 16 quality target has reference floor 16; coverage remains rectangular.
`minVolumeQuality` (default 2) and `maxVolumeQuality` (default Infinity) explicitly constrain that reference.
After initial selection, a retained tier has a bounded hysteresis band in both directions:
coarsening waits until support exceeds 1.1 times the current side, and refinement waits until it
falls below 0.45 times that side. Quality requests then debounce for one second independently of
physical `autoShrink` and `shrinkDelay`. Explicit quality limits remain authoritative.
The separate deferred quality request/transition can temporarily leave the active grid at its old tier.
Gas prepares replacement pressure and resampling shaders asynchronously in small batches before
adopting automatic tier changes; the current grid continues running and growing guards meanwhile.
Export texture backing is retained, with any required growth handled by the existing staged allocator.
Coarsening averages scalar cells conservatively (eight for a 2x change) and averages tangential MAC
faces (four per component); refinement uses trilinear sampling at the correct scalar/face locations.
Pressure operators change with spacing/topology, so their preparation is distinct from the averaging
pass. Manual subdivision changes still require structural rebuilds.
`autoVolumeQuality` defaults to true; set it to false to freeze quality independently of bounds growth.
Supplying `volumeQuality` selects a static side unless `autoVolumeQuality: true` is also supplied.
For example, `{ volumeQuality: 4, brickSubdivisions: 3, cellSubdivisions: 4 }` fixes cell width at
4 / 128 while the rectangular domain can continue to grow. With power-of-two quantization enabled,
use a power-of-two side. `module.setSpatialGridOptions({ autoVolumeQuality: false })` freezes the
current live tier; set `volumeQuality` explicitly to choose another fixed tier.

Automatic sizing uses actual occupied particle support plus an empty guard brick layer, with no
velocity/lifetime forecasting. Compact metadata is reused from the existing hash build; gas includes
its occupied field support. Independent face growth restores the guard, while removal waits for
`shrinkDelay`. Offset movement emerges from growing one face and later shrinking the opposite face.
`grid.resolveOccupiedBounds(support)` resolves this layout for consumers following persistent fields.
Explicit bounds remain fixed. Ballistic/Kill/Contain policies apply at physical caps.

Fluid modules use an internal 0.75-second, per-face outward-travel guard: particle travel is capped
by remaining lifetime, gas travel by current effective density decay. A compact median/maximum
blend chooses at least one guard brick, with immediate growth and delayed shrink. Actual occupancy
still handles arbitrary jumps. Support readback queues coverage using the last travel estimate before
waiting for a fresh histogram. Guards use the **current** brick width; coverage never waits for quality.
A separate request considers world travel once when selecting a future quality tier. The automatic
consumer waits at least one stable second, applies pending coverage first, and delays quality shrink
by `shrinkDelay` as well. `resolveDeferredQuality(now)` exposes this separate request to custom consumers.
Quality transitions still remap/rebuild synchronously when consumed; deferred scheduling does not
make that structural work asynchronous. No future module/force behavior is forecast.
`grid.resolveOccupiedBounds(support, now, { travel: [minusX, plusX, minusY, plusY, minusZ, plusZ] })`
also accepts explicit world-space travel for consumers; an array instead supplies explicit depths.

Sparse fluid admission prioritizes physical state and immediate transport over source/stencil and
optional halos. Empty domain guards do not require cell residency. Capacity preparation uses observed demand and
headroom; compatible later requests can finish one tier and stage the next without restarting it.
`system.prepare(renderer)` captures predictable gas shader variants against stable particle bindings
without emitting or advancing time. Cold quality-tier transitions remain structural and may hitch.

At unchanged cell width, fluid domain growth, shrink and whole-brick shifts update runtime addressing.
They retain compatible resident fields, pressure warm starts and compiled kernels. Empty guard
coverage does not allocate resident pages. Directory, resident-pool and export-texture capacity grow
separately through staged allocation; changing volume quality still remaps incompatible state.
Gas simulation coverage also proceeds while larger derived export textures prepare. Until the swap,
the exported window is bounded by current texture capacity and follows occupied support; its bounds
can temporarily cover less than the simulation rectangle. Resident simulation data is retained.
`showGridHelper` displays every brick in the rectangular domain: orange contains physical gas/markers,
green is empty. The cyan outline is the domain rectangle. Colors use the current simulation fields,
not residency or request priority. Empty bricks can have no cell page; they still have a valid
rectangular address and appear green. The helper adds a GPU occupancy reduction only while enabled,
with no directory readback. Growing a face adds a rectangular layer of addresses, not individual
irregular bricks. Cell-page allocation remains lazy and separate from domain dimensions.

Gas requests a complete one-brick receiver ring around each physical brick before transport,
in addition to the per-cell velocity/stencil requests. This runs once per logical brick, not once
per cell, and cannot recursively seed further rings. It gives receiver cell storage a whole brick
of lead rather than waiting until density is within a few cells of the page edge. Distant green
bricks remain without cell pages. Residency limits can still deny requests; the helper's green
color indicates zero physical occupancy, not a guarantee of allocated cell storage.

Gas resident-pool capacity grows independently of both the logical rectangle and quality. Compatible
capacity changes allocate zero-initialized backing buffers, copy retained prefixes/packed planes,
and rebind existing storage nodes. Grid, pressure, transport, source and export program identities
remain stable. Capacity, sentinel addresses, and packed-plane strides are runtime shader parameters;
no capacity-dependent program compilation is required. Device storage-binding limits still cap a pool.
Pressure reduction scratch reserves the supported count with runtime compact work; it does not
reserve simulation cells for vacant domain bricks.

Without an explicit `initialBrickCapacity`, `system.prepare(renderer)` sizes the initial gas pool from
readable emitter geometry, birth position/scale envelopes and their immediate one-brick receiver ring,
plus existing CPU particle support. Unique brick addresses are counted across sources, rounded to a
geometric tier and limited by `maxBrickCapacity`/device limits. A single bootstrap slot exists before
preparation. This is a conservative source-envelope estimate, not sampling of future random births;
opaque GPU-only position/scale expressions cannot be predicted by that CPU census. Explicit initial
reserves remain authoritative. Preparation does not emit particles or advance simulation time.
Empty logical guard addresses do not add cell-storage demand to that initial census.

A GPU `VolumeField` may provide `textureResolution` for backing capacity larger than its logical
`resolution`. The logical data occupies the lower-origin region; the renderer handles texture-coordinate
scaling independently from world bounds. CPU fields omit this member.

### Spatial Aggregation And Levels

`SpatialAggregator<T, "cpu">` preserves the octree's existing `new` and `combine` members
and optionally adds `finalize`. Parent reductions retain raw values. `getAggregate(node)`
finalizes a copy, so deriving averages does not overwrite sums used by other nodes.
CPU values remain ordinary objects; they do not require GPU layouts. Keep finalized state
copyable; native data containers, ordinary object graphs and classes with `clone()` are supported.

`SpatialAggregator<Layout, "gpu">` uses the same concepts with explicit channel types and
TSL expressions. Layout channels support `float`, `uint`, `int`, `vec2`, `vec3` and `vec4`.
Combine raw sums/counts associatively; derive means or normalized vectors in `finalize`.
GPU finalization operates on local expressions, leaving stored raw reductions intact.

```ts
const grid = new ParticleSpatialGrid({ levels: SpatialLevels.All }, {
  layout: { count: 'uint', sum: 'vec3' },
  new: particle => ({
    count: uint(particle ? 1 : 0),
    sum: particle?.position ?? vec3(0),
  }),
  combine: (a, b) => ({ count: a.count.add(b.count), sum: a.sum.add(b.sum) }),
  finalize: a => ({ count: a.count, sum: a.sum.div(float(a.count).max(1)) }),
});
grid.rebuild(renderer, buffers);
const readRegions = grid.computeRegions(0, region => {
  const average = grid.getAggregate(region);
  const bounds = grid.getBounds(region);
  const children = grid.getChildren(region);
  // Consume these GPU expressions in your compute graph; they are not synchronous CPU values.
});
```

Import the TSL constructors from `three/tsl`, and `ParticleSpatialGrid`/`SpatialLevels`
from RZMPS. GPU aggregate callbacks construct graphs, not JavaScript particle callbacks.
The fixed layout and callbacks are construction-time configuration; use captured uniforms
for runtime numeric tuning. Callers own and dispose compute kernels returned by the grid.

Let B be `brickSubdivisions` and D be B plus `cellSubdivisions`:

| `levels` | Maintained depths |
| --- | --- |
| `SpatialLevels.None` / `"none"` / `"None"`, default | D only |
| `SpatialLevels.Bricks` / `"bricks"` / `"Bricks"` | 0 through B, plus D |
| `SpatialLevels.Cells` / `"cells"` / `"Cells"` | B through D |
| `SpatialLevels.All` / `"*"` / `"All"` | 0 through D |
| Readonly integer array | Requested depths plus D, sorted and deduplicated |

Both brick/cell presets include B. Invalid depths or presets throw rather than silently
clamping. The finest neighbor-query index is always present. Ordinary default/None grids
without an aggregator allocate no extra region directories. A non-None preset, explicit
depth array, or aggregator enables the optional sparse region directory; aggregate storage
is allocated only when an aggregator is supplied. Managed grids share only compatible levels.

Region handles are frame-local GPU expressions with a `valid` flag. `locateNode(position, depth)`
finds an occupied region at a maintained depth; outside or empty regions are invalid.
`getRegions(depth)` gives a GPU count and ordinal-to-region accessor; `computeRegions`
dispatches only occupied regions. Requesting an unmaintained depth throws, rather than reporting
an empty level. `getChildren` means the **next maintained finer level**, not necessarily depth+1.
Repeat child traversal to reach occupied descendants without scanning every region at that depth.
At the finest level, `getParticleIndices` gives the region's particle membership range.

CPU octree handles are ordinary node references. Its existing `locate` returns the deepest
available containing node up to the requested depth, with the existing root fallback outside
bounds; grid `locate(Vector3, depth)` remains a CPU coordinate utility, not a GPU lookup.
Both structures provide `getAggregate`, `getBounds` and `getChildren` where those concepts agree.
Neither node references nor GPU region indices should be retained across rebuilds.

Additional grid levels use exact sparse cell keys, compact occupied-cell lists and child
ranges. The finest summaries are constructed once; coarser levels combine raw child summaries.
No dense world-volume arrays or separate pointer-based GPU octree are constructed. Hash-table
capacity clearing remains allocation-sized, while scans and aggregate work use occupied counts.

Dynamic numbers, vectors, colors, ranges, sets, and callbacks are available to built-in GPU
components. Callback curves are sampled into interpolated uniform tables at
`ParticleSystem.Settings.GPU_DYNAMIC_VALUE_RESOLUTION`; increase it when a high-frequency curve needs more
fidelity. TSL nodes can be supplied directly where a dynamic value is evaluated by GPU code.

## GPU Gas Modules

`GasModule` is a `Module` subclass for gas cells, discovered through `system.getModules` by
`GasSimulation` and `VolumeRenderer`. Add it to the system's normal module list. It does not execute
per particle. Tags select overlapping consumers, untagged modules apply to all, lower priorities
run first, and `enabled: false` disables all of its callbacks.

```ts
import { GasModule } from '@rzmps/rzmps';
import { mix, smoothstep } from 'three/tsl';

system.addModule(new GasModule({
  modifyGPU(cell, context) {
    context.turbulenceNoiseStrength.mulAssign(cell.temperature.clamp(0, 1));
  },
  modifyRenderGPU(cell, context) {
    const hot = smoothstep(0.15, 0.8, cell.temperature);
    const dense = smoothstep(0.2, 1.2, cell.density);
    context.densityNoiseContrast.mulAssign(mix(1, mix(1.6, 0.75, dense), hot));
  },
}));
```

Callbacks build TSL expressions, rather than run JavaScript once per cell. Use `assign`, `addAssign`
and `mulAssign` on their nodes. `cell.position` is in simulation space; density is concentration,
temperature is specific heat, color is unpremultiplied RGB, and velocity is in simulation units per
second. Simulation callbacks receive the existing turbulence, vorticity, buoyancy, dissipation and
`scalarDiffusion` coefficients after the ordinary by-temperature/by-density controls. Coefficients
are local expressions, not new transported fields. Rules inline at the existing solver sampling
sites: velocity transport commits velocity, scalar transport commits density/temperature/color,
and confinement reads its local strength. Keep callbacks deterministic shader operations; do not
assume a once-per-frame JavaScript invocation or accumulate JavaScript side effects.

### Source-aware gas initialization

`GasModule` also accepts `initialize(particles, emission, context)` and a TSL counterpart,
`initializeGPU(particles, emission, context)`. These run after gathering a cell's contributing particles,
before depositing the resulting emission. Mutate `emission.density`, `temperature`, `color` and
`velocity` in place. Temperature, color and velocity are specific values; density is the deposited
concentration increment, already including source strength and this substep's emission duration.
Initializers run in module priority order and only change new emission, not gas already in the grid.

The CPU callback receives a readonly particle array. `GasModule.initializeEmission` provides ordered
CPU/reference evaluation for custom deposition pipelines and tests. GasSimulation remains GPU-only:
supply `initializeGPU` when using an initializer with it, just as other GPU modules need TSL callbacks.
The GPU collection exposes a node-valued `length` and a repeatable `forEach` sparse-query iterator;
its optional second argument is that particle's original deposited density contribution. No per-cell
particle arrays or readback are created. An initializer's changes do not rewrite these original weights.

```ts
const cooling = new GasModule({
  initialize(particles, emission) {
    let heat = 0, count = 0;
    for (const particle of particles) {
      const source = particle.source;
      if (!source) continue;
      heat += Math.max(0, 1 - source.age / source.lifetime);
      count++;
    }
    if (count) emission.temperature *= heat / count;
  },
  initializeGPU(particles, emission) {
    const heat = float(0).toVar(), count = float(0).toVar();
    particles.forEach(particle => {
      const source = particle.source;
      If(source.valid, () => {
        heat.addAssign(float(1).sub(source.age.div(source.lifetime)).clamp(0, 1));
        count.addAssign(1);
      });
    });
    If(count.greaterThan(0), () => emission.temperature.mulAssign(heat.div(count)));
  },
});
```

Import `GasModule` from `@rzmps/rzmps` and `If`, `float` from `three/tsl`. CPU particles retain their
live source independently of simulation space. GPU source views expose `valid`, `age`, `lifetime`
and `metadata[key]` for registered/CPU-managed sources. Arbitrary numeric or boolean metadata keys
are discovered when constructing the shader; missing keys return zero. Unsupported metadata values
throw rather than silently lose data. Removed or reused source slots read as invalid, and the CPU
particle's `source` becomes undefined when that source is no longer alive. Native GPU-parent source
origins are not mapped into this registered-source table.

Initialization contexts provide the logical cell index, position, delta time and elapsed time; the GPU
context also exposes the existing read-only gas grid query. Keep initializers deterministic: the same
emission rule is evaluated at the velocity-coupling, scalar-deposition and transient visual-source sites.
They must not rely on one JavaScript call per cell/frame or change simulation fields directly. Later
initializers see earlier edits to the local emission, while grid queries read the input of the current
solver stage. Source clocks and metadata updates reuse the compiled graph.

### Gas source mass and physical diffusion

Gas density is concentration: integrated mass is `sum(density * cellWidth³)`. A source emits
`particle.mass * particle.alpha * sourceStrength * dt` mass. Its physical scale controls the footprint,
not total emission. A voxel-integrated, normalized tent deposits the corresponding concentration;
sub-cell sources and quality changes therefore do not multiply injected mass. Heat and transported
color use the same mass weights, as do render-time source attributes. Sources outside the domain or
inside solid cells can still lose their blocked/out-of-domain contribution.

`scalarDiffusion` is diffusivity in **world units²/second**, not a cell-neighbor mixing rate. Diffusion
reads the completed advected snapshot and mixes six neighbors with coefficient
`6 * scalarDiffusion * dt / cellWidth²`. The base coefficient limits substep duration to
`cellWidth² / (6 * scalarDiffusion)`, including when velocity-based adaptive stepping is off.
Existing substep/time budgets still apply; very high diffusivity can require a larger `maxFluidSubsteps`.
A `GasModule` that increases local diffusivity must respect that same stability bound; arbitrary
shader overrides cannot request extra CPU-side substeps. The mixing coefficient is clamped to keep
such overrides positive, but clamping alone cannot preserve their requested physical diffusion rate.

To convert an old six-neighbor mixing rate at reference width `h`, use `D = oldRate * h² / 6`.
Density migration remains concentration-preserving: do not rescale stored density when cells resize.
Semi-Lagrangian numerical smoothing and other discretization errors still depend on resolution;
physical source normalization does not imply identical voxel detail at every quality.

### Neighborhood queries (GPU only)

Simulation callbacks also receive `context.index`, the logical `ivec3` gas-cell coordinate (not a
resident slot or texture coordinate), and `context.grid: GasGridQuery`. Use TSL arithmetic for offsets:

```ts
system.addModule(new GasModule({
  modifyGPU(cell, context) {
    const { x, y, z } = context.index;
    const above = context.grid.getCell(x, y.add(1), z);
    cell.temperature.addAssign(above.temperature.sub(cell.temperature).mul(context.deltaTime));
  },
}));
```

`getCell` returns a read-only cell view with position, density, specific temperature/color and velocity
in the same units as the callback's cell. Nonresident, sparse and out-of-domain coordinates return
zero density, temperature, velocity and color; position remains the requested logical cell's center.
Queries do not clamp to the nearest edge cell. They reuse the existing sparse page directory and
bind/read fields lazily. Repeated or distant queries can be expensive; no neighborhood cache is added.
Assigning to a returned node changes only a shader-local expression, never neighboring field storage.

Queries always read immutable **input snapshots**, independent of GPU invocation order. Each callback
can commit changes only to its own current cell. Modules in one fused stage apply local modifications
in priority order, but **all modules query the same pre-module snapshot**: later modules cannot query
an earlier module's committed neighbor edits. No extra inter-module synchronization or dispatches
are introduced. These are stage snapshots, not one snapshot for the entire frame: scalar rules query
the transported scalar inputs and projected velocity; velocity transport queries its pre-transport
inputs. Confinement writes its velocity buffer in place, so its module callbacks use the unchanged
pre-force velocity for both local state and queries. They do not sample partially confined velocities.
Neighborhood access is not exposed on transient render callbacks.

Render callbacks receive local `density`, `color`, `opacity`, `emission`, `densityNoiseStrength`,
`densityNoiseContrast` and `densityNoiseFrequency` before masking and lighting. Cell density/color
alias their context counterparts. All render changes are transient, and no sparse field is allocated.
Native GPU producers can supply `VolumeField.sampleVelocityGPU` to read their existing velocity;
fields without this optional sampler return zero velocity. Velocity is sampled lazily only when a
callback reads it. GasSimulation exports cell-centered velocity into a third RGBA16F texture alongside
color and density/temperature/speed/vorticity. Render sampling uses hardware trilinear filtering, with
no sparse-buffer or pressure-face reads in the raymarch. Existing export dispatches write the additional
texture, including transient visual velocity changes. Speed remains cached in the parameter texture,
so speed-only modifiers do not need the vector texture. Texture allocation, growth, clearing and reset
follow the other derived volume fields; tier changes retain the render sampling graph.
The solver still uses staggered-face velocities for its own transport/projection. Custom providers
must likewise keep any captured velocity bindings current after storage/layout replacement.
Existing scene-depth clipping, bounds and collisions remain authoritative.

Change `module.modifyGasGPU` (the simulation callback passed as `modifyGPU` in the constructor),
`module.modifyRenderGPU`, or the corresponding `module.options` callback to replace a rule.
Callback replacement, ordering, enable/tag changes and `needsUpdate = true` invalidate the relevant
graphs without rebuilding gas storage. `deps: () => [capturedValue]` also detects changed captured
configuration; TSL uniforms can update without recompilation. Simulation-only changes leave the
render graph intact, and render-only changes leave transport graphs intact. The initial gas callback
implementation requires native WebGPU; it adds no CPU gas-cell processing or WebGL callback path.

## Volume sampling

VolumeRenderer reconstructs density and transported parameters with trilinear filtering at explicit
LOD zero by default. `interpolation: 'Nearest'` deliberately selects nearest voxels; `'Cubic'` offers
more expensive B-spline reconstruction. Simulation fields and resolution are independent of this choice.

`VolumeRenderer.samplesPerVoxel` is the intended **render-quality** control when a coarse simulation
or a larger ray interval looks too sparsely sampled. It defaults to one sample per smallest contributing
voxel. Increasing it decreases the requested world-space sample spacing without changing the gas grid,
density, diffusion or simulation quality. For example, changing cell width from 0.125 to 0.25 while
raising `samplesPerVoxel` from 2 to 4 requests the same 0.0625-unit spacing.

`steps` caps the raymarch sample budget. A long interval can exhaust that budget and force wider spacing;
increase `steps` as well if increasing `samplesPerVoxel` alone has little effect. Both controls increase
rendering cost, and neither is increased automatically. Distance-corrected opacity keeps the field's
extinction independent of step length, subject to ordinary sampling error. These controls improve visual
sampling, not the physical detail available in a coarse simulation. The current coarse-volume appearance
is supported as-is; users choose this quality/performance tradeoff explicitly in the API or GUI.

Full-strength jitter remains the default (`jitterStrength: 1`). Each camera ray fetches one phase from
an embedded, periodic 32×32 blue-noise rank texture; its integration strata use an irrational rotation
of that phase. This avoids piecewise-constant world-cell offsets appearing as large surface facets.
The texture is one kilobyte, requires no asset load or runtime generation, and is released with its
renderer. Jitter remains stable for a given pixel and seed, with no temporal history or frame seed.
`jitterSeed` changes the phase, and zero strength still samples interval midpoints.

This distributes finite-sampling error into fine grain rather than removing the intentional jitter
tradeoff. It does not filter simulation fields or blur density before masking. Interval-length opacity
integration, sparse skipping and the user-selected ray/sample budgets remain unchanged. Coarse
occupancy and reconstruction metadata still use nearest reads intentionally; those control lookups
are separate from density reconstruction.

## Volumetric Lighting Grids

`LightingGrid` is an opt-in, renderer-side directional lighting field. It is independent of simulation
storage and resolution. Without it, VolumeRenderer retains its existing simple directional lighting.

```ts
import { VolumeRenderer } from '@rzmps/rzmps';

const volume = new VolumeRenderer({ lightingGridOptions: {} });
```

A configured example keeps lighting probes much coarser than gas cells:

```ts
const volume = new VolumeRenderer({ lightingGridOptions: {
  levels: 2,             // Cascades.
  directions: 4,         // Four finest directions, eight on the coarser cascade.
  cellSize: 0.5,          // World-space probe spacing, independent of gas subdivisions.
  levelScale: 2,
  samplesPerInterval: 4,
  environmentIntensity: 1,
  scatteringIterations: 1,
  includeSceneLights: true,
} });
```

The default is three cascades, six finest Fibonacci-sphere directions (doubling per coarser cascade),
and a finest probe spacing of the power-of-two enclosing side divided by eight. Explicit
`cellSize` requests fixed world-space lighting detail. If a growing domain would exceed the
2048-texel packed directional texture limit, probe spacing doubles until the layout fits instead
of aborting the render loop. `statistics.probeSpacing` reports the effective spacing; the configured
`cellSize` stays unchanged and is restored as the domain shrinks. This protects texture dimensions,
not a total GPU-memory budget. `margin` accepts a number or Vector3, and
`maxDistance` defaults to the power-of-two enclosing lighting-domain diagonal. Bounds remain rectangular,
snapped to a world-anchored lattice so face growth does not slide existing probes. These small,
coarse fields use dense directional textures rather than allocating gas cells or another sparse
particle index. Rectangular bounds/vector/addressing conventions reuse the shared spatial utilities.

Each probe/direction stores half-float RGB radiance and remaining transmission. Short, fine intervals
merge with longer, coarser intervals as `Lnear + Tnear * Lfar`, `Tnear * Tfar`. Overlapping distance
weights blend direct-light contributions across interval boundaries rather than switching shells abruptly.
Angular transfer is evaluated on coarse probes before spatial upsampling. This commutes with linear
interpolation, preserves the direction weights, and avoids repeating every coarse-bin sample at every
fine probe; an additional half-float intermediate introduces only rounding differences. Hardware trilinear
sampling interpolates probes; balanced angular interpolation preserves both constant fields and
integrated radiance between Fibonacci direction sets. Direction counts control angular detail;
`cellSize`, `levels`, `levelScale` and `samplesPerInterval` control spatial/interval approximation.

Directional, point and spot lights are injected during grid updates. Point/spot lights with finite
`distance` outside the domain are initially filtered. Once admitted, a light remains eligible throughout
the volume until removed from the scene; its range controls smooth dilution rather than a hard cutoff.
Scene membership is cached and invalidated on object
add/remove; transforms, visibility, intensity, color, distance, decay and spot cones are tracked.
Point attenuation uses Three's inverse-distance-power convention with a positive finite-range tail:
`1 / (1 + (distanceToLight / light.distance)^4)^2`. Zero light distance means no range attenuation.
The camera raymarch uses a pre-averaged one-fetch field for zero `anisotropy`. Averaging commutes
with trilinear interpolation, so this preserves the directional integral. Nonzero HG `anisotropy`
uses the complete directional set; neither path loops over scene lights per ray sample.
Grid lighting replaces the simple directional/shadow path completely; render-module emission is
added separately. Existing renderer controls and density remain unchanged.

Far-field input priority is baked Three LightProbeGrid SH atlas, uniform LightProbe SH, supported
`scene.environment` (or explicit `environment`), then constant `ambient` (linear 0.2 gray by default).
LightProbeGrid's packed atlas is read directly; this class does not bake it. SH is evaluated as
radiance, not the cosine-convolved irradiance used for surface shading. Raw cube and equirectangular
textures are supported, including scene environment rotation/intensity; PMREM CubeUV textures
currently use ambient fallback. `environmentIntensity` multiplies all far-field inputs. Set
`includeSceneLights: false` when baked lighting already includes those static direct lights.

VolumeRenderer supplies world-space bounds and an extinction sampler derived from its opacity
mapping: `sigma = -log(1 - opacity)`, with `T = exp(-sigma * segmentLength)`. Coarse lighting uses
unmasked density rather than re-running visual noise at every lighting sample. Changing density,
volume transforms, opacity, lights or environment updates the lighting field; unchanged inputs do
not dispatch. Grid updates run before the volume draw and work while the simulation is paused.
All cascades currently refresh together on an input change, favoring current shadows over stale
coarse illumination. `scatteringIterations` adds a small isotropic redistribution approximation;
it is not a physically exact multiple-scattering solver and defaults to one iteration.

The smoke/fire presets use fixed `cellSize: 0.25` and `maxDistance: 16`, inheriting the volume-oriented
defaults: two cascades (`levels`), four finest directions, four interval samples and one scattering iteration. Automatic probe-spacing tiers can still change approximation
when a domain crosses a power-of-two reference; explicit spacing and interval distance avoid that change.

The demo prepares new GPU systems once. Replacing scene geometry retains the live particle root;
it does not detach systems, clear their fields or rerun full preparation. Subsequent updates use the
ordinary clock and bounded catch-up/substeps, including across loading gaps. Scene colliders and
lighting are rediscovered by their existing update paths.

Reduced-resolution volume reconstruction retains the closest depth-compatible contributing ray when
bilateral weights underflow at narrow scene-depth gaps. Its metadata records the first nonzero volume
contribution, rather than the proxy-box entry, to keep rear fog occluded by foreground geometry.

For direct use, call `prepare(renderer, scene, bounds, source?)` to warm resources, or
`update(renderer, scene, bounds, source?)` to refresh them. An optional source supplies an owner,
world-space extinction callback, numeric/string `version`, and structural `shaderKey`. Increment
version after density changes, and shaderKey after changing the callback's captured graph structure.
Set `needsUpdate = true` after rebaking GPU-only probe textures whose Three texture version does not
change. LightingGrid exposes its own benchmarks and lightweight `statistics` for probe count,
directional entries, owned GPU texture/light-record memory and update count.

VolumeRenderer accepts a partial `lightingGridOptions` object, creates its own internal grid and
updates that instance when configuration changes. Omission disables lighting and releases its GPU
resources; renderer destruction also disposes the managed grid. Sharing an options object does not
share resources. This matches managed `spatialGridOptions`, `octreeOptions` and `cubemapOptions`.
The smoke and fire demos enable this option by default. Discovery retains out-of-range lights so
moving one into range updates the volume without reattaching it. Scene membership and HDRI changes
refresh the grid during rendering, including while simulation is paused.

Scene AmbientLight contributes unoccluded irradiance, matching Three.js's ambient-light convention.
Environment textures are projected to low-frequency SH on the GPU and cached until they change.
Equirectangular projection integrates every texel with its solid-angle weight, preventing small,
bright HDR sources from disappearing between Fibonacci directions. Existing LightProbe/LightProbeGrid
coefficients are consumed directly. These inputs feed the grid, not separate per-ray lighting loops.
The exported LightingGrid class remains available for independent GPU consumers, which own its
prepare/update/dispose lifecycle. It is not passed as a VolumeRenderer constructor argument.

Native WebGPU is required for cascades. WebGL VolumeRenderer retains its simpler lighting path.
This first implementation does not ray trace opaque geometry or use fluid collision cells for
shadows; coarse interpolation can leak light across thin features. Low direction counts can smooth
narrow beams and HG highlights. Increase lighting quality independently of fluid quality when those
approximations matter. The feature is volumetric lighting, not a replacement for surface GI.

## Emitters and Spatial Effects

Built-in GPU emission supports rate, distance rate, timed bursts, tags, initial values, LOD, and
volume, surface, or vertex sampling from buffer geometry. CPU and GPU volume emission share the
shape's baked Halton sample table. `volumeSamples` is `"auto"` by default; assigning a number fixes
the table size, while changing geometry or the sample setting rebuilds it. Surface selection is
weighted by triangle area. Burst times are normalized emission-cycle values from 0 through 1.

Emitters use the built-in GPU birth pipeline; they are configured through `Emitter` and
`EmissionShape`, not extended with a separate shader callback. Custom behavior belongs in a
module or spatial effect after birth.

Custom `SpatialEffect` implementations pair the CPU `modify`, `condition`, and `test` callbacks
with `modifyGPU`, `conditionGPU`, and `testGPU`. The GPU test returns a float influence from 0 to 1,
which supplies feather strength to `modifyGPU`. Built-in analytic volumes are batched and indexed.
Custom geometry uses a baked field, controlled by `bakedFieldResolution`; set `updatePolicy` to
`Static`, `TransformDynamic`, or `GeometryDynamic` when automatic change detection is not the best
fit. Custom tests are not bounds-filtered because RZMPS cannot assume they depend on geometry.

## Renderers, Events, and Readback

GPU-native renderers override `_updateGPU` and consume `GPUParticleBufferState` or the compact
render-output buffer. A renderer whose implementation needs ordinary `Particle` objects can
override `_updateGPU` and call the protected `updateCPUFromGPU` helper. It selectively reads the
requested fields, ignores overlapping requests while one is pending, and passes the resulting
particles through the renderer's public `update` method. Override `updateGPUUsesCPUReadback` to
keep child expansion on that CPU path:

```ts
class DebugRenderer extends Renderer {
  get updateGPUUsesCPUReadback() { return true; }

  _updateGPU(buffers, system, deltaTime) {
    this.updateCPUFromGPU(
      buffers,
      system,
      deltaTime,
      64,
      ["position", "color", "alpha"],
    );
  }

  _update(particles) {
    // Render the selectively reconstructed Particle objects.
  }
}
```

Request only the slots and fields the renderer actually consumes. Outside a renderer, use the
public system API directly:

```ts
const samples = await system.selectiveReadback(64, ["position", "color", "alpha"]);
```

Readback is delayed and may return no result if its bounded pool is busy. Do not use it to drive
same-frame simulation decisions. Lifecycle and collision events are also delivered asynchronously
from GPU buffers, so listeners and CPU audio/render views can lag simulation slightly. GPU-native
subsystems consume spawn, death, collision, and continuous emission on the GPU; update only the
root system, as on CPU.

Subsystem `shouldEmitGPU` predicates run in a separate eligibility pass and can request a
managed parent spatial grid. Source selection therefore does not bind the neighbor-query
buffers into each birth shader. See [subsystems](subsystems.md) for CPU/GPU selector pairing,
event snapshots, current-neighborhood semantics and callback invalidation.

Native subsystem births stay within WebGPU's default limit of eight compute-stage storage-buffer
bindings. Parent and child particle state each use separate float and integer buffers. The
remaining pass-specific bindings come from packed allocation state, the emitter-runtime fields
actually referenced by that pass, and packed shape-sampling data. Emitters dispatch separately so
adding emitters does not accumulate their geometry bindings in one shader. Applications do not
need to request a higher device limit.

## Collision and Neighbor Queries

`Collision` selects `ThreeCollisionBackend` for CPU processing and `ThreeGPUCollisionBackend` for
GPU processing when no backend is supplied. An explicit CPU-only backend makes the module GPU
incompatible. GPU collision does not support applying impulses back to scene bodies. Classify GPU
geometry with `GeometryUpdatePolicy`: static geometry is built once, transform-dynamic
geometry updates transforms, and geometry-dynamic meshes refit or rebuild changed acceleration
data.

Use `ParticleOctree` for CPU neighbor work and `ParticleSpatialGrid` for GPU queries. A grid query
emits TSL and invokes its visitor in shader code; it does not return JavaScript particles. Bounds
can expand automatically, but a larger volume lowers spatial resolution because the logical cell
count stays fixed. `maxQuerySteps: 0` performs unbounded exact traversal; a positive value is an
explicit performance cap.

## Configuration and Validation

Built-in components synchronize ordinary runtime property changes before each GPU frame. Constant
and sampled value changes update uniforms; structural changes invalidate and rebuild the affected
compute graph or resources. Custom components should expose changed scalar/vector data through
their GPU parameter nodes and set `needsUpdate = true` when changing graph structure, geometry
layout, callback identity, or buffer ownership.

Test both execution paths. WebGPU rendering alone does not prove GPU simulation is active: assert
`isGPUProcessingActive` after rendering has captured its context. Compare CPU and GPU behavior at
fixed timesteps, exercise resets and subsystem events, and inspect `gpuBufferStats`,
`gpuEventStats`, `gpuSpatialStats`, `gpuSelectiveReadbackStats`, and `gpuConfigurationStats` when
profiling. GPU output is expected to be behaviorally equivalent, not bit-for-bit identical.

See [renderer children and population LOD](./renderer-children-lod.md) for system quality, destructive culling, visual expansion, hierarchy access, and default GPU buffer limits.

### Reading demo profiler metrics

The demo formats `system.benchmarks.snapshot()`; no collection session or GPU readback is required.
Root/subsystem `system/particleCount`, `system/childrenCount`, `system/allocatedSlots` and
`system/usedSlots` supply the universal counters. Fluid module providers expose `grid/width`,
`grid/height`, `grid/depth` and `grid/cellSize`. These are numeric public benchmark gauges.
Renderer paths expose `activeLights` and `allocatedLights` (LightRenderer), `playingClips`
(AudioRenderer, including event cues) and `activeDecals` (DecalRenderer). Unused pooled lights and
stopped audio clips do not count as active. Decals count persistent live instances, including those
whose source particles have died. The demo groups active counts by renderer type in a distinct section;
sprites, meshes and trails retain the universal particle-count presentation.
