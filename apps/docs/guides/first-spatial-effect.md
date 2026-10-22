# First Spatial Effect

Spatial effects modify particles based on scene-space volumes or custom tests.
Use a built-in force field when particles should react to an area in the scene.

```ts
import * as THREE from "three";
import { ParticleForceField } from "@rzmps/rzmps";

const updraft = ParticleForceField.Sphere({
  direction: new THREE.Vector3(0, 2, 0),
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

Name the updraft (`updraft.name = 'updraft'`) before using the filter shown above. A filter cannot find an unnamed field by that name. The direction vector supplies acceleration while the field applies its timestep. In custom callbacks, multiply acceleration by deltaTime before adding it to velocity.

For a custom volume modifier, use `SpatialEffect.Box((particle, deltaTime) => { ... }, options, width, height, depth)`. Scale and position it like another Object3D. A custom `test` option can replace the geometric inclusion rule, while `inverted` applies to the opposite side of a volume. Choose a permanent priority for forces and a transient priority for temporary color or scale changes.

Scene discovery and module-level collections serve different purposes. A generic field modifies intersecting particles directly; a specialized affector can instead be collected by a module such as Boids. See [spatial collections](spatial-effects.md) for explicit selection and filtering, and [module priority](module-priority.md) for execution phases.
