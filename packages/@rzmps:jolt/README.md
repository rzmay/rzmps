# @rzmps/jolt

Jolt Physics collision support for [`rzmps`](https://www.npmjs.com/package/rzmps).

`@rzmps/jolt` allows particles using the rzmps `Collision` module to collide with
bodies in an existing Jolt physics simulation.

It integrates with
[`@barclah/jolt-physics`](https://www.npmjs.com/package/@barclah/jolt-physics),
a WebAssembly/JavaScript binding for Jolt Physics. The package exposes an
asynchronous initializer that returns the Jolt module used to construct the
simulation.

## Installation

```bash
npm install @rzmps/jolt @barclah/jolt-physics
```

`rzmps`, `three`, and `@barclah/jolt-physics` are peer dependencies.

## Usage

Initialize Jolt and create your `JoltInterface` normally:

```ts
import initJolt from "@barclah/jolt-physics";
import { JoltCollisionBackend } from "@rzmps/jolt";
import { Collision } from "rzmps";

const Jolt = await initJolt();

// Configure JoltSettings...
const physicsInterface = new Jolt.JoltInterface(settings);

const collision = new Collision({
  backend: new JoltCollisionBackend({
    Jolt,
    interface: physicsInterface,
    objectLayer: 1,
  }),
});
```

The `Jolt` module must be the same initialized module instance used to create
the supplied `JoltInterface`.

`objectLayer` determines which Jolt collision-layer rules are used when querying
the world. It defaults to `1`.

Custom query filters can also be supplied:

```ts
new JoltCollisionBackend({
  Jolt,
  interface: physicsInterface,
  broadPhaseLayerFilter,
  objectLayerFilter,
  bodyFilter,
  shapeFilter,
});
```

The backend does not initialize, step, or otherwise manage the Jolt simulation
itself.

## Particle impulses

Particles with a non-zero mass can transfer momentum to Jolt rigid bodies when
they collide:

```ts
initialValues: {
  mass: 0.1,
}
```

Mass defaults to `0`, so particles do not affect physics bodies unless
explicitly enabled.

## Cleanup

Jolt uses native WebAssembly allocations which are not garbage-collected
automatically. Destroy the backend before destroying the associated
`JoltInterface`:

```ts
backend.destroy();
Jolt.destroy(physicsInterface);
```

Any bodies created by the application should also be removed and destroyed
through Jolt's `BodyInterface` before destroying the interface.
