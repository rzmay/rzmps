# @rzmps/rapier

Rapier collision support for [`rzmps`](https://www.npmjs.com/package/rzmps).

`@rzmps/rapier` allows particles using the rzmps `Collision` module to collide
with bodies in an existing Rapier physics world.

It uses
[`@dimforge/rapier3d-compat`](https://www.npmjs.com/package/@dimforge/rapier3d-compat),
which provides Rapier's official 3D JavaScript bindings with the WebAssembly
binary embedded for broader bundler compatibility.

## Installation

```bash
npm install @rzmps/rapier @dimforge/rapier3d-compat
```

`rzmps`, `three`, and `@dimforge/rapier3d-compat` are peer dependencies.

## Usage

Initialize Rapier and create your world normally:

```ts
import RAPIER from "@dimforge/rapier3d-compat";
import { RapierCollisionBackend } from "@rzmps/rapier";
import { Collision } from "rzmps";

await RAPIER.init();

const world = new RAPIER.World({
  x: 0,
  y: -9.81,
  z: 0,
});

const collision = new Collision({
  backend: new RapierCollisionBackend({
    RAPIER,
    world,
  }),
});
```

The initialized `RAPIER` module should be the same module instance used to
create the supplied `World`.

The backend does not create, step, or manage the Rapier simulation itself.

## Particle impulses

If a particle has a non-zero mass, collisions can transfer momentum to dynamic
Rapier rigid bodies.

```ts
initialValues: {
  mass: 0.1,
}
```

A mass of `0` disables rigid-body interaction and is the default.

Static and kinematic bodies are unaffected by particle impulses.
