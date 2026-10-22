# Collision and Physics

The base package includes `ThreeCollisionBackend`, which raycasts against a
Three.js scene.

For GPU processing, `Collision` automatically selects `ThreeGPUCollisionBackend` when no backend
is supplied. It uses packed `three-mesh-bvh` acceleration data and distinguishes static,
transform-dynamic, and geometry-dynamic scene meshes. Supplying an explicit CPU physics backend
makes the collision module GPU-incompatible, and applying impulses to scene bodies remains a CPU
feature. See [GPU processing](gpu-processing.md) before choosing an explicit backend.

See the generated API for constructor options and defaults.

The `ThreeCollisionBackend` uses two octrees for static and dynamic collisions.
Sorting objects into static and dynamic can be done automatically, or with
supporting identifiers passed into the constructor options. Explicitly stated
`staticObjects` and `dynamicObjects` lists are treated as the source of truth if
present.

If explicit lists are not provided, the scene is traversed and the
`staticObjectFilter`, `dynamicObjectFilter`, and `objectFilter` predicates are
used to select objects. `objectFilter` selects whether objects are included at
all but does not decide what is considered static or dynamic.

If none of these predicates are provided, the octrees are automatically
constructed from the scene traversal, with distinctions between static and
dynamic objects being made based on movement in the scene.

For external physics engines, use the extension packages:

| Package         | Engine       | npm                                                                            |
| --------------- | ------------ | ------------------------------------------------------------------------------ |
| `@rzmps/rapier` | Rapier       | [npmjs.com/package/@rzmps/rapier](https://www.npmjs.com/package/@rzmps/rapier) |
| `@rzmps/jolt`   | Jolt Physics | [npmjs.com/package/@rzmps/jolt](https://www.npmjs.com/package/@rzmps/jolt)     |
| `@rzmps/ammo`   | Ammo.js      | [npmjs.com/package/@rzmps/ammo](https://www.npmjs.com/package/@rzmps/ammo)     |

```ts
import { Collision } from "@rzmps/rzmps";
import { RapierCollisionBackend } from "@rzmps/rapier";

const collision = new Collision({
  backend: new RapierCollisionBackend({ RAPIER, world }),
  bounce: 0.6,
  dampen: 0.1,
  radiusScale: 1,
  lifetimeLoss: 0.2,
  applyImpulses: true,
});
```

Physics backends receive an existing physics world. They do not create, step, or
own the physics simulation.

