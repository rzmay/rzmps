# First Particle System

This guide creates a small sprite-based burst in an existing Three.js scene.

```ts
import * as THREE from "three";
import {
  ColorOverLifetime,
  EmissionShape,
  Emitter,
  ParticleSystem,
  ScaleOverLifetime,
  SpriteRenderer,
} from "@rzmps/rzmps";

const particles = new ParticleSystem({
  emitters: new Emitter({
    source: EmissionShape.Sphere(),
    rate: 60,
    radialSpeed: 2,
    initialValues: {
      lifetime: 1.25,
      scale: 0.2,
      color: "#ff9f43",
    },
  }),
  modules: [
    new ColorOverLifetime({ alpha: (t) => 1 - t }),
    new ScaleOverLifetime({
      scale: (t) => 1 + t,
    }),
  ],
  renderers: new SpriteRenderer(undefined, {
    materialOptions: {
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    },
  }),
});

scene.add(particles);

function animate() {
  requestAnimationFrame(animate);
  particles.update();
  renderer.render(scene, camera);
}

animate();
```

`ParticleSystem` extends `THREE.Object3D`, so it can be positioned, parented,
hidden, and removed like any other Three.js object. Call `update()` once per
frame before rendering.

Install `@rzmps/rzmps`, `three`, and the `three-mesh-bvh` peer dependency before using the imports above. Supply an existing scene, camera, renderer, and animation loop; this guide does not create a second renderer for your application.

The example emits 60 particles per second, each living 1.25 seconds. That gives about 75 live sprites at steady state. Radial speed 2 spreads the burst source, while scale 0.2 keeps individual sprites small enough to overlap without covering the whole view. The alpha curve removes the sprite at death; the scale multiplier expands it from its initial size to twice that size.

The configuration loops by default. For a single event, use a burst with `rate: 0`, set `looping: false`, and choose an `endBehavior` appropriate to your ownership model. The system is already playing when created. `start()` is useful for resuming or restarting after explicit control changes.

Call `update()` exactly once per displayed frame. Do not update subsystems separately. For offline inspection, `advanceFrames(60, 1 / 60)` advances a second synchronously using the same simulation path; render the scene afterward. A paused system remains paused. `simulationSpeed` scales each supplied step.

Destroy the system during application teardown to release renderer resources. Removing it from the scene only performs temporary cleanup. See [composition](concepts.md), [module priority](module-priority.md), and the [Fire example](../examples/fire.md) for a complete effect and parameter explanations.
