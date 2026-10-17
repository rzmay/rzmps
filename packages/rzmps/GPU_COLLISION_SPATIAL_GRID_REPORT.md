# GPU Collision And Spatial Grid Implementation

## Implementation

- GPU collision uses `three-mesh-bvh/webgpu` `BVHComputeData` (version 0.9.16) for a packed TLAS and deduplicated geometry BLAS data. A focused custom shapecast performs world-space capsule/triangle tests.
- Static objects build once. Transform-dynamic updates call `updateTransforms()`. Geometry revisions refit an existing `boundsTree` when available and repack the current library buffers; topology changes rebuild. `invalidateGeometry()` covers mutations that do not update attribute versions.
- CPU collision remains in `ThreeCollisionBackend`; it now tracks position/index versions, counts, geometry replacement, and explicit invalidation without GPU buffer ownership.
- `ParticleSpatialGrid` uses a sparse hash table with atomic linked-list insertion. Records retain complete cell coordinates and particle generations, so hash collisions and slot reuse are exact.
- Bounds reduction, hysteretic expansion, cell assignment, and grid construction run on GPU. Storage scales with particle capacity rather than logical world volume.
- GPU Boids enumerates individual exact-radius neighbors. CPU Boids retains its aggregate octree algorithm.

## Scheduling And Ownership

Earlier permanent modifiers are stored before a requested grid build. Compatible modules share one system-managed build for that snapshot. Explicit grid instances are caller-owned; option-created grids are system-owned and disposed with the system.

Collision BVH updates are independent of particle-grid construction. Collision remains a pre-movement phase and continues to emit existing GPU collision event records.

## Removed Infrastructure

- CPU octree flattening and flattened GPU scene buffers.
- The old GPU capsule/octree traversal helper.
- Scene-global automatic collision backend replacement.
- The unreleased `gpuCollision` feature flag.
- GPU-specific fields and tuning branches in `ThreeCollisionBackend`.

## Limitations

- `three-mesh-bvh` marks its WebGPU API unstable. Version 0.9.16 supports transform-only TLAS updates, but geometry refits still require repacking GPU buffers.
- Arbitrary GPU-only skeletal or morph deformation is not claimed. Evaluated geometry must be supplied explicitly with `setEvaluatedGeometry`; no GPU-to-CPU particle readback is performed.
- Grid expansion keeps logical resolution fixed, so physical cell size and query work can increase as bounds grow. Dense neighborhoods remain proportional to actual neighbors.
- A positive `maxQuerySteps` is an explicit approximate mode. The default `0` performs complete traversal.

## Verification

See `tests/particle-spatial-grid.test.mjs`, `tests/gpu-collision-backend.test.mjs`, `tests/particle-octree-boids.test.mjs`, and the existing GPU event/subsystem suites. Browser benchmarks expose paired CPU/GPU spatial-grid Boids cases at 1K, 10K, and 100K particles plus a static collision scene under `RZMPS_BENCHMARK_SUITE=spatial-grid`.
