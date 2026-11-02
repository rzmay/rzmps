# Renderer Children and Population LOD

Set `ParticleSystem.lod` to reduce simulated population with distance. The system calculates one `quality` value from zero through one and shares it with every emitter and renderer.

```ts
import { CompensationMode, Emitter, ParticleSystem, SpriteRenderer, LightRenderer } from '@rzmps/rzmps';

const system = new ParticleSystem({
  lod: { distance: 20, quality: 0.5, maxLevel: 3, continuous: true },
  emitters: new Emitter({ rate: 200 }),
  renderers: new SpriteRenderer(undefined, {
    children: {
      count: 2,
      radius: 0.5,
      scale: [1, 0.6],
      alpha: [0.9, 0.5],
      randomizeScale: 0.2,
      randomizeAlpha: 0.15,
      radialFalloff: t => t * t,
    },
    compensation: CompensationMode.Children,
  }),
});
```

At quality 0.5, emission requests are halved before particles are allocated. Each birth receives a random priority below its birth quality, independent of its ID. When quality drops, particles at or above the new threshold are permanently removed before modules, movement, spatial queries, and collision. LOD removal does not dispatch normal death callbacks, death audio, or death subsystems. Surviving particles run every simulation step.

Increasing quality allows ordinary emission to restore density. Finite bursts may never recover their omitted particles. `simulationDistance` remains an independent hard cutoff, and `maxParticles` limits simulation capacity.

## Spatial grouping

`Renderer` can merge the eligible, tag-filtered simulation population into render-only
representatives. Sprites and meshes default to `count: -1` (unlimited), `ratio: 1`,
and `groupingRadius: -1` (unbounded). Lights default to `count: 50`.

```ts
const lights = new LightRenderer({ count: 8, ratio: 0.1, groupingRadius: -1 });
```

For N eligible particles, the target is
`K = clamp(Math.round(Math.min(count < 0 ? Infinity : count, ratio * N)), 0, N)`.
Positive half-integers round up. A zero count or ratio produces no representatives;
negative count and positive Infinity are unlimited. K at least N preserves original
particles without CPU aggregation. This count is computed before artistic children.

The renderer builds a world-space snapshot of eligible particles in an aggregated
`ParticleOctree` on CPU or a multiresolution `ParticleSpatialGrid` on GPU. Its policy
distributes a K-anchor budget through occupied children in proportion to population,
stopping at regions assigned one anchor. This is adaptive population-weighted coverage,
not simply a ranking of the K most populated fixed cells. Cell summaries supply centroids.
CPU selection snaps to an actual source particle; GPU selection descends toward the
centroid and cooperatively snaps within a finest cell. Leaves receiving multiple
anchors choose distinct member slots, including coincident populations.
Every particle then contributes to its nearest anchor, exactly once. Anchors own
themselves to keep coincident groups nonempty. Identity breaks otherwise equal
spatial ties. Selection never consumes a dense region greedily.

A negative `groupingRadius` accepts every particle. A nonnegative radius limits
contributions to that distance from a selected anchor, measured in world units,
including the system transform for local simulation. Particles outside all
acceptance spheres remain unrepresented. K still requests nonempty representatives,
but finite radii cannot guarantee coverage of the population. Translating the effect
away from the origin does not change the radius.

Aggregates use weights `1 / (1 + distanceSquared / scaleSquared)`. The scale is the
positive finite radius when provided, otherwise the selected region's bounding-box
diagonal, with an epsilon floor. Position, color, alpha, scale, rotation, velocity,
and available age/render attributes are weighted averages; mass and visual
`Particle.contribution` are sums. Ordinary simulation particles have contribution
one. Lights retain their averaged brightness and alpha semantics: merging more
particles does not multiply a light's intensity by its membership count. A singleton retains its original values.
Simulation state, custom data and birth snapshots remain untouched.

All memberships and anchors are recomputed each update. Spatial regions and
weighted centroids improve coherence, but there is no stored group identity,
membership, temporal smoothing, or guarantee of continuous motion at split or
nearest-center boundaries. Renderers with identity-based histories can observe
anchor changes. Audio, trail and decal renderers retain their established `ratio`
selectors for sounds, trail histories and lifecycle projections; their shared
spatial grouping cap is `count` independently of those legacy selectors.
`DecalRenderer.count` continues to report live decals; its constructor's `count`
option supplies the preprocessing cap.

Grouping runs before artistic children, followed by LOD compensation. For example,
100 eligible particles grouped to four representatives with two artistic children
produce twelve visual instances, or twenty-four at quality 0.5 with Children
compensation. `renderedChildCount` counts only added children, never the population
removed by grouping. CPU compensation spacing still samples the original simulated
population; native GPU compensation resolves each aggregate's anchor slot in the
system-owned spatial spacing data.

CPU grouping uses source-octree aggregates for selection and a separate anchor octree
to prune nearest-center queries. It no longer performs grouping-specific Morton sorting
or range splitting. Identity ordering within selected regions makes CPU ties reproducible.
GPU grouping uses general sparse level directories and reductions, rather than a private
512-cell histogram or serial region heap. It maintains depths zero through four for its
source snapshot, then uses the existing coarse anchor hash for exact nearest-center queries.
The source and anchor indices are separate because they contain different populations.

GPU refinement processes independent regions in parallel at each maintained depth.
Generic aggregate construction and anchor snapping use cooperative workgroups.
Compact occupied-cell lists drive indirect scans and reductions; no construction readback
is required. The number of cached build passes depends on maintained levels and capacity,
not K iterations of a global priority queue. Final weighted memberships still use linked
lists and sequential per-group reduction, a remaining optimization opportunity.
Degenerate nearest queries can still inspect K anchors. Passes fit the portable
eight-storage-buffer limit. GPU grouping adds a compact world-space snapshot, optional
spatial directories/aggregates, and per-region selection scratch; ordinary single-resolution
grid users do not allocate these optional structures. CPU and GPU use the same
weighting formula but may choose different regions and anchors. GPU
scatter and linked reduction order can vary with scheduling, so float sums and
identity ties are not bit-for-bit identical between backends.

On November 2, 2026, native Chromium WebGPU on Apple Metal measured these complete GPU
grouping costs, including spatial construction and final weighted aggregation. Each case
used ten warmup updates and forty timestamped samples; values are medians in milliseconds.
The baseline is the preceding histogram/serial-heap implementation on the same machine.

| Live particles / reserved slots | Representatives | Before | Hierarchical |
| --- | ---: | ---: | ---: |
| 10,000 / 32,768 | 18 | 0.918 | 0.646 |
| 10,000 / 32,768 | 128 | 0.951 | 0.380 |
| 2,000 / 32,768 | 512 | 3.820 | 0.367 |
| 10,000 / 131,072 | 18 | 0.935 | 0.670 |

These are compute-only measurements, not whole-scene FPS guarantees or a CPU/GPU comparison.
Reproduce the current workloads with `node tests/visual/renderer-grouping-performance.mjs`;
the script records adapter details, CPU submission and queue-completed timings, and GPU stages
to JSON. The optional `--stages` mode changes batching for attribution and should not be used
for the before/after totals above. Final linked-list aggregation remains a low-K bottleneck.

CPU scene lights read back only the compact GPU aggregates; grouping itself stays
on GPU. Lights are allocated predictively when the renderer is attached, using
`ceil(min(count, ratio * system.estimateParticleCount(tags)))`. Negative or infinite
count omits the cap; the existing default cap is 50. The estimate shares the particle
buffer allocator's `rate * lifetime + bursts` calculation, without its minimum
buffer size or power-of-two padding. Dynamic curves use the same conservative
sampling, cached per step. A manual population with no emission model falls back
to the finite count cap. Artistic children and LOD copies expand this predicted
reserve after the grouping cap, in the same order as rendering.

Reserved scene lights stay registered with `visible: true` and zero intensity
when unused. They are visually invisible, but activating an existing light does
not change the registered light count or trigger light-count shader variants.
If the actual output exceeds the prediction, the pool grows immediately. Rate,
lifetime, ratio or count changes refresh the prediction; unpredictable
movement-driven and subsystem emission can still require growth.

```ts
const lights = new LightRenderer({
  count: 18,
  ratio: 0.3,
  allocation: { shrinkThreshold: 0.75, shrinkDelay: 1 },
});
```

`allocation.shrinkThreshold` is the required-capacity/pool-capacity fraction below
which shrinking is considered (default 0.75). `allocation.shrinkDelay` is the
continuous time in seconds spent below that threshold (default 1). Recovery resets
the timer. The target is `max(predicted reserve, current render output)`, so idle
systems retain their anticipated warm capacity and surplus from temporary bursts
can eventually be released. The delay uses monotonic wall time and works with
asynchronous GPU readback; it does not count frames. Zero delay shrinks immediately;
`Infinity` delay or zero threshold disables shrinking. These properties are runtime
configurable and exposed in the demo's Light Allocation controls.

Grouping always precedes artistic children, which precede LOD compensation on CPU
and GPU. Optional level directories represent exact logical cells; hash buckets can
collide and must not be treated as spatial regions. The finest neighbor index remains
available. A system-wide live-slot list and selective occupied-bucket clearing are
separate potential optimizations, not prerequisites for these aggregate directories.

## Artistic children

The base `Renderer` expands its visual population before passing it to a renderer implementation. Each child inherits its immediate parent's attributes; only its position, scale, and alpha receive artistic modifiers. Children never enter `system.particles`, run modules, collide, or cause lifecycle events.

`renderer.renderedChildCount` reports additional artistic and LOD children. CPU counts update each frame. Reading this property during native GPU processing requests asynchronous diagnostics from the small counters buffer, at most four times per second; it does not read particle data back. The demo adds rendered and child totals to its particle counter only when children are present.

`count` is a timeless dynamic number: constants, ranges, and sets use deterministic per-parent selection. Counts are floored and clamped to nonnegative integers. They do not depend on age. A `[1, 3]` range normally produces one or two children. Zero is the default.

`radius` is the maximum spherical displacement, in particle simulation coordinates. Offsets remain fixed relative to the parent's position and do not rotate with its orientation. The default radius is zero.

`scale` and `alpha` are radial `ValueByParameter` multipliers. Numeric child multipliers are constants; ranges and callbacks vary with normalized radial distance. Both default to one. Each property's parameter is `clamp(distance / radius + randomize * (random - 0.5), 0, 1)`, followed by `radialFalloff`. Radius zero supplies distance zero. Randomization defaults to zero and easing defaults to linear. Scale and alpha use independent random streams, so changing alpha randomness does not move or resize a child.

Callbacks and easing use the existing GPU sampled-curve convention. TSL nodes are GPU-only and follow the existing dynamic-value compatibility rules.

## Compensation

`compensation` defaults to `CompensationMode.None`.

- `Size` multiplies visual scale by `1 / sqrt(quality)`, approximating constant billboard area. Simulated scale remains unchanged.
- `Children` adds approximately `1 / quality - 1` additional children to every original and artistic child. Fractional copies use deterministic selection. LOD copies inherit scale and opacity without further artistic modifiers.

There are exactly two generation stages. LOD children do not create further children. Quality zero generates no compensation copies. At quality 0.5, one simulated particle with two artistic children produces six visual instances.

The particle system owns compensation spacing. CPU views share a shallow `ParticleOctree` and cached per-root estimates; native GPU views share a `ParticleSpatialGrid` and a GPU spacing pass. The spatial structures inspect a bounded sample of local simulated neighbors. Estimates are retained for a root particle's lifetime to avoid offset jitter. Isolated particles fall back to their visual extent, so expanding system bounds cannot scatter compensation children. Spatial preparation runs only when compensation needs it, and CPU trees rebuild only when new roots need estimates.

## Identity and backend behavior

CPU particles expose `id`, `isChild`, `parent`, and `root`. Simulated particles have a null parent and are their own root. Child IDs derive from the immediate parent's identity and child ordinal. The base renderer uses `Particle.shallowClone(id, overrides)` for each visual child. Inherited vectors, colors, tags, custom data, and simulation snapshots are shared read-only. Each child owns its position; artistic scale modifiers and size compensation copy scale before modifying it. LOD children share their immediate parent’s scale and color. Child IDs use namespaced strings such as `root[0]`, `root[1]`, and `root[0][0]`. Artistic and LOD children share one ordinal sequence per parent; a root's LOD children follow its artistic children. Timeless seeded evaluation keeps counts and offsets stable across updates. Trails use the same stable child IDs to preserve independent histories.

Use `shallowClone` for a read-only view with selected replacements. Override vectors and colors are used directly, while unspecified references remain shared:

```ts
const view = particle.shallowClone('visual-copy', {
  position: particle.position.clone().add(offset),
  alpha: particle.alpha * 0.5,
});
```

`shallowClone` preserves the particle prototype and skips constructor work, ID generation, and new simulation snapshots. Renderers and custom consumers must avoid mutating shared attributes. Use `clone()` when independent mutable particle attributes are required.

GPU simulation contexts expose a computed slot/generation identity. Expanded render contexts resolve child identities and immediate/root views through one compact parent-index/ordinal mapping, with at most two hierarchy lookups. On GPU, guard dynamic parent access with `isChild`; original render slots resolve their parent view to themselves because shader-side null references do not exist. Simulation contexts have a null parent.

GPU-native sprites and meshes consume temporary packed visual buffers without reading child data back to the CPU. Artistic and LOD children occupy successive compact segments. Atomic allocation order may change packing, while identities remain independent of packing. Indirect draws use the GPU-produced visual range. Buffers are reused and grow in aggregate rather than reserving each parent's maximum possible count.

As with simulation storage, GPU visual storage has a practical capacity. The reusable arena reserves from the count distribution's mean, variance, and largest outlier and is bounded by `maxStorageBufferBindingSize`. Numeric TSL constants and uniforms use their current values; opaque GPU expressions reserve the full device-bounded arena because their counts cannot be bounded on CPU. Writes outside its capacity are discarded and counted internally. Very large or unbounded TSL count distributions should be avoided. CPU-input renderers expand children on CPU. With grouping enabled they read the compact GPU aggregates; otherwise their existing selective readback mechanism is used.

The generated compute and render shaders must fit the default eight-storage-buffer limit. `npm run preview -- --example lodStress --backend webgpu` records actual generated shader binding counts and active processing backend in its metadata.

Custom renderers implement `_update` for CPU input and `_updateGPU` for native GPU input. The public `update` and `updateGPU` methods perform base-class preprocessing before calling these hooks.

## Migration

Remove the former update-rate LOD settings from systems, emitters, modules, and renderers. Put distance/falloff/quality settings in `ParticleSystem.lod`. Replace renderer size compensation with `compensation: CompensationMode.Size`, or choose `Children` for density approximation. Emitter and renderer count selection are now coordinated by the simulated population; modules always update survivors at their normal frequency.
