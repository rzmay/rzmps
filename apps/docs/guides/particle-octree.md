# Particle Spatial Acceleration

RZMPS provides complementary structures for particle-to-particle work:

| Operation | `ParticleOctree` (CPU) | `ParticleSpatialGrid` (GPU) |
| --- | --- | --- |
| Bounds | `setBounds`, `bounds` | `setBounds`, `bounds` |
| Resolution | `maxDepth`, `particlesPerLeaf` | `maxDepth`, brick/cell subdivisions |
| Update | `rebuild(particles, tags?)` | `rebuild(renderer, buffers, token?)` |
| Position lookup | `locate(position)` returns a node | `locate(position)` returns a cell coordinate |
| Radius query | node/neighbors and aggregates | `forEachParticleInRadius` TSL visitor |
| Quality | `timeQuality` | `timeQuality` |
| Cleanup | garbage-collected CPU data | `dispose(renderer?)` / `destroy(renderer?)` |

Use `ParticleOctree` for CPU comparisons, neighborhood queries, and aggregate approximations. Use
`ParticleSpatialGrid` for GPU comparisons and exact-radius shader queries. They share conceptual
configuration names where the meanings match, but their results are intentionally different:
octree traversal returns CPU nodes and aggregates, while grid queries emit shader work and never
materialize a JavaScript particle array.

## CPU: ParticleOctree

`ParticleOctree<TAggregate>` groups particle positions into cubic cells and computes an application-defined aggregate. It supports flocking and approximate neighborhood calculations. It is separate from mesh collision acceleration: its entries are particle indices, not triangle faces.

Supply a configuration and an aggregator with `new` and `combine` functions. `new` must handle an absent particle because the tree asks it for an empty node aggregate. `combine` merges aggregates; return independent state or carefully manage mutation so sibling nodes cannot corrupt one another.

```ts
import { ParticleOctree } from '@rzmps/rzmps';

const tree = new ParticleOctree<number>({
  maxDepth: 6,
  particlesPerLeaf: 8,
  timeQuality: 1,
}, {
  new: (particle) => particle ? 1 : 0,
  combine: (a, b) => a + b,
});

tree.setBounds(system.boundingBox);
tree.rebuild(system.particles);
const node = tree.locate(system.particles[0].position);
```

Guard the last line when the population is empty. `rebuild` accepts an optional tag selection. Only particles inside the resolved bounds and matching that selection contribute. Choose bounds in the same coordinate space as particle positions. Call `setBounds` when your population moves beyond the original volume; `locate` returns the root for a position outside the tree, which is not a nearest-neighbor result.

`maxDepth` defaults to 8 and `particlesPerLeaf` to 4. Deeper trees reduce cell size but increase node construction and neighbor bookkeeping. Increasing leaf capacity limits subdivision in dense populations. `timeQuality` defaults to 1; values below 1 skip some rebuilds after the first build. Check the boolean return from `rebuild` before assuming aggregates describe the current frame.

`getNodes()` returns a new array of node references. Nodes expose bounds, neighbors, aggregate, and indices into the particle array passed to the last successful rebuild. Rebuilds replace node identities; do not retain nodes across rebuilds. Treat skipped rebuild data as stale if particles have been removed or reordered. `quantizeBounds` can stabilize moving bounds to reduce spatial churn, at the cost of looser bounds.

The [Boids example](../examples/boids.md) demonstrates aggregation in a complete effect. Profile construction as well as query costs before increasing depth or rebuild frequency.

## GPU: ParticleSpatialGrid

Modules normally request a managed grid instead of constructing one. Set `useSpatialGrid: true`
for defaults or pass options through `spatialGrid`; the module's `modifyGPU` callback receives the
grid as its final argument. The equivalent CPU callback receives its managed octree when
`useOctree` or `octreeOptions` is configured.

```ts
const neighbors = new Module(
  (particle, deltaTime, system, octree) => {
    // CPU traversal can use octree nodes and aggregates.
  },
  {
    useOctree: true,
    useSpatialGrid: true,
    spatialGrid: { brickSubdivisions: 3, cellSubdivisions: 4 },
    modifyGPU: (particle, deltaTime, context, grid) => {
      grid?.forEachParticleInRadius(
        particle.position,
        float(2),
        (neighbor, distanceSquared) => {
          // Build TSL operations using neighbor and distanceSquared.
        },
        { excludeIndex: particle.index },
      );
    },
  },
);
```

Custom infrastructure can instantiate `ParticleSpatialGrid` directly, call `rebuild` with a
WebGPU renderer and `GPUParticleBufferState`, then dispose it explicitly. A positive
`maxQuerySteps` truncates traversal; zero is unbounded. Automatic bounds expansion prevents lost
particles, but because the number of cells is fixed, expanding bounds increases cell size and
reduces spatial resolution. Keep bounds tight enough for the expected population and use
`readDiagnostics` only for validation or profiling because it performs asynchronous GPU readback.
