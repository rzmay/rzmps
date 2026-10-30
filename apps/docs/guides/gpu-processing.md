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

Dynamic numbers, vectors, colors, ranges, sets, and callbacks are available to built-in GPU
components. Callback curves are sampled into interpolated uniform tables at
`ParticleSystem.GPU_DYNAMIC_VALUE_RESOLUTION`; increase it when a high-frequency curve needs more
fidelity. TSL nodes can be supplied directly where a dynamic value is evaluated by GPU code.

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
geometry with `CollisionGeometryUpdatePolicy`: static geometry is built once, transform-dynamic
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
