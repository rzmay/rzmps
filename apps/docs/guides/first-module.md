# First Module

Modules change particle values over time. A custom module receives the live
particle, the frame delta, and the owning particle system.

```ts
import { Module } from "@rzmps/rzmps";

const riseAndFade = new Module((particle, deltaTime) => {
  particle.velocity.y += 0.5 * deltaTime;
  particle.alpha *= 1 - particle.time;
});
```

Attach it to a system with the rest of your modules:

```ts
const particles = new ParticleSystem({
  emitters,
  modules: [riseAndFade],
  renderers,
});
```

Use `condition` when only some particles should be affected:

```ts
const sparksOnly = new Module((particle) => {
  particle.scale.multiplyScalar(1.2);
}, {
  condition: (particle) => particle.tags?.includes("spark") ?? false,
});
```

The exported `ModuleCondition` type receives the same arguments as `ModuleUpdate`:
`(particle, deltaTime, particleSystem?, octree?)`, and returns a boolean. The system and managed
octree are optional, just as they are for the update callback. Conditions run after alive and tag
filtering and receive the same frame delta and context as the update. Existing particle-only
predicates still work. On GPU, `ModuleGPUCondition` matches `ModuleGPUUpdate`'s arguments and
returns a TSL boolean node.

For performance-sensitive modules, avoid allocating objects inside the per
particle callback. Reuse vectors and colors outside the callback when possible.

A plain Module defaults to permanent priority. The example's velocity increment accumulates over time; multiplying by
delta seconds makes 0.5 an acceleration rather than an amount per frame. Its alpha multiplication also accumulates. For
a fade defined entirely by normalized age, prefer ColorOverLifetime or set `priority: Module.Priority.Transient` so the
fade is reapplied to cached base alpha each frame.

Use `Module.Priority.PreMovementTransient` when a temporary velocity adjustment must affect this frame's integration.
Render-time transient modules run after movement. See [module priority](module-priority.md) before combining several
modules that assign the same property.

## System Update Hooks

`prepare(system, deltaTime)` can also run effect-level scheduling once per simulation step, even when a module does
not modify individual particles. Supply an empty CPU callback and `modifyGPU() {}` to keep both backends supported,
then put the shared scheduling work in prepare(). Call `super.prepare()` to preserve the base preparation behavior.
This follows the system's pause state, simulation speed and fixed-step advancement.

[Acid](../examples/acid.md) uses this pattern to schedule independent bubble events from persistent decal sources.
Its per-particle callbacks intentionally do nothing. The demo factory returns a ParticleSystem, so this hook lets it
keep scheduling on the system's clock without owning an animation loop. Applications with their own animation loop
can instead schedule events there before calling the root system's update().

## Managed Octree

Particle-to-particle comparisons should use a managed `ParticleOctree` instead of scanning the
whole particle array for every particle. Enable it in the module options; RZMPS rebuilds it and
passes it as the callback's fourth argument.

```ts
const crowdDrag = new Module(
  (particle, deltaTime, _system, octree) => {
    const nearbyCount = octree
      .particlesInRadius(particle.position, 2)
      .filter((neighbor) => neighbor !== particle)
      .length;
    const damping = Math.max(0, 1 - nearbyCount * 0.02 * deltaTime);
    particle.velocity.multiplyScalar(damping);
  },
  {
    useOctree: true,
    octreeOptions: {
      maxDepth: 6,
      particlesPerLeaf: 8,
    },
  },
);
```

The octree prunes nodes outside the query sphere, then returns the particles that pass exact
distance checks in the remaining leaves. Custom aggregate data remains useful when an
approximation such as average position or velocity is cheaper than collecting every matching
particle; see
[particle spatial acceleration](particle-octree.md).

For reusable behavior, extend Module and pass your per-particle callback and options to `super`. Override
`prepare(system, deltaTime)` when expensive shared work should happen once per frame; call `super.prepare` if using
automatic spatial-effect collection. Put resource cleanup in `cleanup()`. Dependencies in `dependents` participate in
normal priority sorting rather than forcing an independent update loop.

Built-in modules already cover forces, noise, scale, rotation, depth, color, and collision. Reuse those when their
semantics match the effect. Custom callbacks are most useful for application-specific logic, and should mutate the
particle provided rather than storing a shared mutable vector in multiple particles.

The callback above is CPU-only. Continue with [First GPU Module](first-gpu-module.md) to add the
equivalent TSL operation, then use [GPU processing](gpu-processing.md) as the reference for managed
spatial queries, invalidation, and testing requirements.
