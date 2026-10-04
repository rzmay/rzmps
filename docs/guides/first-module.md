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
