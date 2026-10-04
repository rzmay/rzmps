# First Spatial Effect

Spatial effects modify particles based on scene-space volumes or custom tests.
Use a built-in force field when particles should react to an area in the scene.

```ts
import { ParticleForceField } from "@rzmps/rzmps";

const updraft = ParticleForceField.Sphere({
  force: (particle) => {
    particle.velocity.y += 0.08;
  },
}, 2);

updraft.position.set(0, 1, 0);
scene.add(updraft);
```

Particle systems discover generic spatial effects in their scene by default.
Disable that behavior per system with `useSpatialEffects: false`, or use
`spatialEffectFilter` to choose which effects apply.

```ts
const particles = new ParticleSystem({
  spatialEffectFilter: (effect) => effect.name === "updraft",
});
```

Use `KillZone` when particles should be removed inside a volume:

```ts
import { KillZone } from "@rzmps/rzmps";

const cleanup = KillZone.Box(10, 4, 10);
cleanup.position.y = -3;
scene.add(cleanup);
```
