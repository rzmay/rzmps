# Renderer Children and Population LOD

Set `ParticleSystem.lod` to reduce simulated population with distance. The system calculates one `quality` value from zero through one and shares it with every emitter and renderer.

```ts
import { CompensationMode, Emitter, ParticleSystem, SpriteRenderer } from '@rzmps/rzmps';

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

## Artistic children

The base `Renderer` expands its visual population before passing it to a renderer implementation. Each child inherits its immediate parent's attributes; only its position, scale, and alpha receive artistic modifiers. Children never enter `system.particles`, run modules, collide, or cause lifecycle events.

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

CPU particles expose `id`, `isChild`, `parent`, and `root`. Simulated particles have a null parent and are their own root. Child IDs derive from the immediate parent's identity and child ordinal. The base renderer uses `Particle.clone()` for each visual child. Child IDs use namespaced strings such as `root[0]`, `root[1]`, and `root[0][0]`. Artistic and LOD children share one ordinal sequence per parent; a root's LOD children follow its artistic children. Timeless seeded evaluation keeps counts and offsets stable across updates. Trails use the same stable child IDs to preserve independent histories.

GPU simulation contexts expose a computed slot/generation identity. Expanded render contexts resolve child identities and immediate/root views through one compact parent-index/ordinal mapping, with at most two hierarchy lookups. On GPU, guard dynamic parent access with `isChild`; original render slots resolve their parent view to themselves because shader-side null references do not exist. Simulation contexts have a null parent.

GPU-native sprites and meshes consume temporary packed visual buffers without reading child data back to the CPU. Artistic and LOD children occupy successive compact segments. Atomic allocation order may change packing, while identities remain independent of packing. Indirect draws use the GPU-produced visual range. Buffers are reused and grow in aggregate rather than reserving each parent's maximum possible count.

As with simulation storage, GPU visual storage has a practical capacity. The reusable arena reserves from the count distribution's mean, variance, and largest outlier and is bounded by `maxStorageBufferBindingSize`. Numeric TSL constants and uniforms use their current values; opaque GPU expressions reserve the full device-bounded arena because their counts cannot be bounded on CPU. Writes outside its capacity are discarded and counted internally. Very large or unbounded TSL count distributions should be avoided. CPU readback renderers, including trails, lights, and audio, keep their existing readback mechanism and expand children on CPU.

The generated compute and render shaders must fit the default eight-storage-buffer limit. `npm run preview -- --example lodStress --backend webgpu` records actual generated shader binding counts and active processing backend in its metadata.

Custom renderers implement `_update` for CPU input and `_updateGPU` for native GPU input. The public `update` and `updateGPU` methods perform base-class preprocessing before calling these hooks.

## Migration

Remove the former update-rate LOD settings from systems, emitters, modules, and renderers. Put distance/falloff/quality settings in `ParticleSystem.lod`. Replace renderer size compensation with `compensation: CompensationMode.Size`, or choose `Children` for density approximation. Emitter and renderer count selection are now coordinated by the simulated population; modules always update survivors at their normal frequency.
