# `@rzmps/ammo`

Ammo.js collision support for [`@rzmps/rzmps`](https://www.npmjs.com/package/@rzmps/rzmps).

Unlike Rapier and Jolt, Ammo.js does not have a single standard npm
distribution. This package therefore does not depend on a specific Ammo.js
package.

Instead, `AmmoCollisionBackend` accepts any compatible initialized Ammo.js
implementation along with its physics world.

## Installation

```bash
npm install @rzmps/ammo
```

Install whichever Ammo.js distribution your application uses separately.

## Usage

```ts
import { AmmoCollisionBackend } from "@rzmps/ammo";
import { Collision } from "@rzmps/rzmps";

const backend = new AmmoCollisionBackend({
  Ammo,
  world,
});

const collision = new Collision({
  backend,
});
```

`Ammo` should be an initialized Ammo.js API implementation, and `world` should
be its `btDiscreteDynamicsWorld`.

This allows `@rzmps/ammo` to work with custom Ammo builds, GitHub builds, WASM
distributions, or other compatible Ammo.js packages.
