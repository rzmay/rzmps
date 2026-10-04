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
      scale: new THREE.Vector3(0.2, 0.2, 0.2),
      color: new THREE.Color("#ff9f43"),
    },
  }),
  modules: [
    new ColorOverLifetime({ alpha: (t) => 1 - t }),
    new ScaleOverLifetime({
      scale: (t) => new THREE.Vector3(1 + t, 1 + t, 1 + t),
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
