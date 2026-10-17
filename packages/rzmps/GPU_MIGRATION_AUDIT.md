# Four-Milestone GPU Migration Audit

Audit date: 2026-10-15

## Final Architecture

- GPU-native systems use one authoritative packed particle pool for simulation,
  allocation, reclamation, emission, and subsystem routing.
- CPU systems retain the existing CPU particle, emitter, renderer, collision,
  and subsystem paths.
- `GPUParticleContext` is shader-local. `GPUParticleStorage` owns packing,
  upload, final commit, and asynchronous readback.
- Permanent and transient pre-movement modifiers plus integration execute in
  one simulation dispatch. Render-time modifiers use a compact render-output
  buffer only when required.
- GPU events and selective readbacks are asynchronous, generation validated,
  sequence ordered, and bounded.
- Batchable spatial effects use packed parameters and a stackless GPU-traversed
  BVH. This effect-instance BVH is separate from the CPU triangle queries that
  continue to use `three-mesh-bvh`.
- GPU-native emitters and subsystem runs keep their timing and snapshots in GPU
  buffers. They do not depend on `Emitter._contextStates`, `_emissionRuns`, CPU
  `Particle` creation, or `addParticle()` slot allocation.

## Obsolete Infrastructure Removed

- Removed `src/GPUParticle.ts`; GPU code is organized under `src/gpu/`.
- Removed `_gpuTransientBaseBuffers`, `_copyGPUParticleBuffer()`,
  `_commitGPUTransientFrame()`, per-module dispatches, and the separate movement
  dispatch.
- Removed the old full `_gpuRenderBuffers` path. `_gpuRenderOutputBuffers` is a
  compact render-only position/rotation/scale/color/alpha/distortion/time/state
  output and is never authoritative simulation state.
- Removed full-state-readback death detection and duplicate event polling from
  the GPU-native lifecycle path.
- No old `GPUParticle` imports, storage-backed module interface, or obsolete
  named paths remain in source.

## Built-In Support

Native GPU modules: all color, distortion, force, limit-velocity, mass,
orientation, rotation, scale, speed, transform-noise, and velocity built-ins.
`Collision` is native with `ThreeCollisionBackend`, `gpuCollision: true`, and
`applyImpulses: false`.

Native GPU spatial effects: `KillZone`; static-parameter `ParticleForceField`.
Dynamic/custom force-field expressions retain the faithful per-instance GPU
path. Box, sphere, cone, and torus influences have packed exact tests and
conservative bounds. `three-mesh-bvh` remains for CPU arbitrary-mesh tests.

Native GPU emission: box, sphere, cone, and torus volume/surface/vertex shapes;
rate, `rateOverDistance`, timed bursts, dynamic initial values, animated source
transforms, local spawn-position offsets, random/all tags, update/count LOD,
standalone emission, continuous contexts, and persistent event runs.

Renderer support:

| Renderer | GPU mode |
| --- | --- |
| `SpriteRenderer` | Direct GPU particle/render-output buffers |
| `MeshRenderer` | Direct GPU particle/render-output buffers |
| `TrailRenderer` | Generation-validated selective readback; particle and ribbon identity tested |
| `LightRenderer` | Bounded selective readback with slot-generation identity |
| `AudioRenderer` | GPU events for one-shots; bounded selective readback for attached audio |
| `LiveCubemap` | System rendering utility, not a particle-state consumer |

Subsystems support continuous, spawn, death, and GPU-collision triggers,
stable ratio selection, all inheritance fields, collision impulse modifiers,
multiple emitters/children, concurrent event runs, and nested dependency-order
scheduling.

## Explicit CPU-Only Or Compatibility Features

- `Boids` and `BoidAffector`: require a GPU particle-neighbor index and a
  dedicated flocking kernel.
- String-key/base `NoiseModule`: its arbitrary CPU callback/cache has no GPU
  equivalent. `TransformByNoise` is native; custom noise modules can provide
  `modifyGPU`.
- Ammo, Jolt, and Rapier collision backends and `Collision.applyImpulses`:
  external-world mutation is CPU owned.
- Arbitrary custom emission geometry, distributed tag selection, and JavaScript
  subsystem `shouldEmit` functions require an explicit `emitGPU`/GPU predicate
  contract or CPU fallback.
- Arbitrary mesh spatial effects remain GPU-compatible through the baked-field
  per-instance path, but are not packed analytic BVH effect types.
- Direct GPU sprite/mesh rendering observes live storage and therefore does not
  reproduce CPU renderer `updateLOD` visual frame freezing. Count LOD is native.
- More than 32 distinct GPU tags triggers explicit CPU compatibility fallback.

## Library Reuse Review

- RZMPS already delegates triangle-mesh proximity tests to `three-mesh-bvh`,
  collision broad-phase construction to Three's `Octree`, procedural noise to
  `fast-simplex-noise`, and shader/storage composition to Three TSL/WebGPU.
- `three-mesh-bvh` indexes triangles for CPU geometry queries. It does not
  replace the mutable packed effect-instance AABB hierarchy consumed by the
  simulation shader, so the two BVHs intentionally remain separate.
- The current dependencies do not provide generation-safe particle allocation,
  bounded asynchronous GPU event queues, selective particle readback, or fused
  emitter/subsystem scheduling. Replacing those pieces would require another
  particle runtime rather than a focused utility library, so no additional
  dependency was added.

## Capacity And Overflow

- Event records: 4,096 per frame by default; eight asynchronous readback
  buffers. Record and dropped-callback-batch overflow is reported by
  `gpuEventStats.overflowCount`; GPU-native child consumers still run.
- Selective readback: eight concurrent buffers by default; saturation is
  reported by `gpuSelectiveReadbackStats.overflowCount`.
- Allocation: bounded by `maxParticles`; `MaxCulling.New` rejection and
  `MaxCulling.Old` replacement are implemented, including one death event for a
  replaced particle.
- Timed bursts support 32 entries per built-in GPU emitter.
- Spatial buffers reserve 2x growth capacity and rebuild explicitly when a type
  contract changes or capacity is exceeded.

## Verification

Passed:

- `npm test --workspace packages/rzmps`
- `npm run build:modules`
- `npm run build --workspace apps/demo`
- Real WebGPU Milestone 1 matrix: 1k/10k/100k particles with 1/5/10/20 modules;
  one simulation dispatch and one simulation-node build in every case.
- Real WebGPU all-native-module case: 1,000 particles, 29 native module classes,
  one fused simulation dispatch plus one expected compact render-output pass.
- Real WebGPU Milestone 2: 4,096 simultaneous deaths delivered 4,096 callbacks;
  5,000 deaths delivered the bounded 4,096 and reported exactly 904 overflows.
- Real WebGPU Milestone 3: 10,000 particles and 129 moving/enabling force-field
  instances shared one implementation, one simulation-node build, one dispatch,
  and stable registry resources after adding the 129th instance.
- Real WebGPU Milestone 4 synthetic lifecycle/nested subsystem case and the
  repository's actual fireworks preset in GPU and CPU modes.
- Unit coverage includes CPU module families, transient/render isolation,
  event ordering/deduplication/delayed-readback/queue bounds, culling paths,
  BVH versus brute force, type contracts, selective identity/bandwidth,
  emitter frame-rate timing, bursts, context independence, and CPU fallback.

Representative measured results on Apple M4 Pro, Chrome 154 headless:

| Case | FPS | Avg update | Dispatches | GPU particle buffer |
| --- | ---: | ---: | ---: | ---: |
| 10k, 20 fused modules | 828 | 0.86 ms | 1 | 3.00 MB |
| 100k, 1 fused module | 79.6 | 11.21 ms | 1 | 24.00 MB |
| 100k, 20 fused modules | 65.4 | 11.72 ms | 1 | 24.00 MB |
| 10k, 129 force fields | 560 | 1.58 ms | 1 | 3.00 MB |

The actual GPU fireworks run transferred 8,257,536 selective-readback bytes
over the measured run with 98.6 ms cumulative readback latency and no selective
overflow. GPU timestamp-query simulation time was not available in the current
benchmark renderer, so GPU execution time is not claimed separately from frame
and CPU update measurements. No pre-refactor benchmark artifact was available
for an apples-to-apples performance delta; the verified architectural delta is
that ordinary module count no longer increases dispatch count.

## Remaining Work

The four milestones are complete for the declared compatibility surface. The
next substantial GPU features are neighbor-indexed boids, external physics
backend integration, and a higher-level programmable custom-emission-shape API.
Trail history remains the largest selective-readback consumer and is the best
candidate for a future fully GPU-native renderer implementation.
