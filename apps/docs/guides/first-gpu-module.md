# First GPU Module

A custom module needs a CPU callback and a TSL callback to behave on both simulation backends.
This example adds the same upward acceleration in each path.

```ts
import { Module, ParticleSystem } from "@rzmps/rzmps";
import { float, vec3 } from "three/tsl";

const updraft = new Module(
  (particle, deltaTime) => {
    particle.velocity.y += 0.5 * deltaTime;
  },
  {
    modifyGPU: (particle, deltaTime) => {
      const acceleration = vec3(0, float(0.5).mul(deltaTime), 0);
      particle.velocity.assign(particle.velocity.add(acceleration));
    },
  },
);

const particles = new ParticleSystem({
  emitters,
  modules: [updraft],
  renderers,
  gpuProcessing: true,
});
```

The CPU callback runs once for each JavaScript particle. The GPU callback runs while RZMPS builds
a compute graph: its particle properties and `deltaTime` are TSL nodes, not current JavaScript
values. Build expressions with TSL functions and write fields with `assign`; JavaScript arithmetic
or branching cannot inspect a node's per-particle value.

The two callbacks should express the same behavior, but they need not use identical algorithms.
`supportsGPU` is true only when `modifyGPU` exists and every custom CPU condition has a matching
`conditionGPU`. After the renderer initializes, use `particles.isGPUProcessingActive` to check the
backend actually selected.

## Conditions and Spatial Queries

A custom CPU `condition` also needs a TSL equivalent:

```ts
const risingOnly = new Module(
  (particle, deltaTime) => {
    particle.velocity.y += 0.5 * deltaTime;
  },
  {
    condition: (particle) => particle.velocity.y > 0,
    conditionGPU: (particle) => particle.velocity.y.greaterThan(0),
    modifyGPU: (particle, deltaTime) => {
      particle.velocity.y.addAssign(float(0.5).mul(deltaTime));
    },
  },
);
```

## Managed Spatial Grid

The GPU counterpart to a managed octree is `ParticleSpatialGrid`. This version of the crowd-drag
module uses the grid's exact-radius query and performs the count entirely in the compute graph:

```ts
const crowdDrag = new Module(
  (particle, deltaTime, _system, octree) => {
    const nearbyCount = octree
      .particlesInRadius(particle.position, 2)
      .filter((neighbor) => neighbor !== particle)
      .length;
    particle.velocity.multiplyScalar(
      Math.max(0, 1 - nearbyCount * 0.02 * deltaTime),
    );
  },
  {
    useOctree: true,
    octreeOptions: { maxDepth: 6, particlesPerLeaf: 8 },
    useSpatialGrid: true,
    spatialGridOptions: { brickSubdivisions: 3, cellSubdivisions: 4 },
    modifyGPU: (particle, deltaTime, _context, grid) => {
      if (!grid) return;

      const nearbyCount = float(0).toVar("nearbyCount");
      grid.forEachParticleInRadius(
        particle.position,
        float(2),
        () => nearbyCount.addAssign(1),
        { excludeIndex: particle.index },
      );
      const damping = float(1)
        .sub(nearbyCount.mul(0.02).mul(deltaTime))
        .max(0);
      particle.velocity.mulAssign(damping);
    },
  },
);
```

RZMPS rebuilds both structures and passes the appropriate one as the final callback argument. A
grid query emits shader-side work and never returns JavaScript particles. Its callback can inspect
each neighbor and the squared distance when a count alone is not enough. Keep query bounds and
grid resolution appropriate for the effect; see
[particle spatial acceleration](particle-octree.md) for configuration and limitations.

Runtime scalar, vector, color, range, and curve properties on built-in modules synchronize to GPU
parameters automatically. A custom class can use its protected `gpuParameters` store for the same
pattern. Set `needsUpdate = true` only when a change alters graph structure or owned resources.

## Killing a Particle

Call `particle.kill()` on either backend. For a permanent boundary rule, pair a CPU condition with a TSL condition:

```ts
const boundary = new Module(
  particle => {
    if (particle.position.y < -10) particle.kill();
  },
  {
    modifyGPU(particle) {
      If(particle.position.y.lessThan(-10), () => {
        particle.kill();
      });
    },
  },
);
```

`If` comes from `three/tsl`. The default module priority is permanent. The GPU helper marks the slot dead immediately
and advances its age past its lifetime using finite values. Normal death-event subscribers still receive one event,
including when the module runs in a separate stored update before integration. Event source snapshots are historical
views and cannot kill a live particle.

The [Fireflies example](../examples/fireflies.md) kills insects outside its volume instead of steering them toward
boundaries, and replenishes them through ordinary emission to maintain a roaming population with a bounded spatial grid.

Continue with [GPU processing](gpu-processing.md) for execution phases, fallback rules, readback,
and validation.
