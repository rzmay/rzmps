# Using ParticleOctree

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
