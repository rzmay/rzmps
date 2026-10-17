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

For performance-sensitive modules, avoid allocating objects inside the per
particle callback. Reuse vectors and colors outside the callback when possible.

A plain Module defaults to permanent priority. The example's velocity increment accumulates over time; multiplying by delta seconds makes 0.5 an acceleration rather than an amount per frame. Its alpha multiplication also accumulates. For a fade defined entirely by normalized age, prefer ColorOverLifetime or set `priority: Module.Priority.Transient` so the fade is reapplied to cached base alpha each frame.

Use `Module.Priority.PreMovementTransient` when a temporary velocity adjustment must affect this frame's integration. Render-time transient modules run after movement. See [module priority](module-priority.md) before combining several modules that assign the same property.

For reusable behavior, extend Module and pass your per-particle callback and options to `super`. Override `prepare(system, deltaTime)` when expensive shared work should happen once per frame; call `super.prepare` if using automatic spatial-effect collection. Put resource cleanup in `cleanup()`. Dependencies in `dependents` participate in normal priority sorting rather than forcing an independent update loop.

Built-in modules already cover forces, noise, scale, rotation, depth, color, and collision. Reuse those when their semantics match the effect. Custom callbacks are most useful for application-specific logic, and should mutate the particle provided rather than storing a shared mutable vector in multiple particles.
