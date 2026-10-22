# First GPU Spatial Effect

A custom spatial effect pairs its ordinary particle modifier with `modifyGPU`. Built-in volume
factories provide the CPU inclusion test and GPU influence calculation automatically.

```ts
import { ParticleSystem, SpatialEffect } from "@rzmps/rzmps";
import { float, vec3 } from "three/tsl";

const updraft = SpatialEffect.Sphere(
  (particle, deltaTime, _system, strength) => {
    particle.velocity.y += 2 * deltaTime * strength;
  },
  {
    automaticFeather: false,
    feather: 0.75,
    modifyGPU: (particle, deltaTime, _context, strength) => {
      const acceleration = vec3(0, float(2).mul(deltaTime).mul(strength), 0);
      particle.velocity.assign(particle.velocity.add(acceleration));
    },
  },
  2,
  24,
  16,
);

updraft.position.set(0, 1, 0);
scene.add(updraft);

const particles = new ParticleSystem({
  emitters,
  modules,
  renderers,
  gpuProcessing: true,
});
scene.add(particles);
```

With `automaticFeather: false`, both callbacks receive a strength from zero through one, so the
example applies feathering explicitly and identically. With automatic feathering enabled, RZMPS
blends supported particle fields around the callback instead.

`SpatialEffect.Sphere`, `Box`, `Cone`, and `Torus` supply matching built-in CPU and GPU tests. Add
`conditionGPU` only when adding a custom CPU `condition`. Add `testGPU` when replacing the volume's
inclusion rule with a custom `test`; it returns a float influence rather than a JavaScript boolean.
Custom geometry without `testGPU` uses a baked influence field.

Spatial effects are scene objects. Their transforms can move while
`updatePolicy: SpatialEffectUpdatePolicy.TransformDynamic` updates transform data without
rebuilding geometry acceleration. Use `GeometryDynamic` only when vertex data itself changes.
Custom tests are not bounds-filtered because RZMPS cannot assume they depend on the effect's
geometry.

After the renderer initializes, verify `particles.isGPUProcessingActive`. Unsupported generic
spatial effects are skipped by GPU simulation instead of forcing the entire system onto CPU, so
also inspect each custom effect's `supportsGPU` while developing it. See
[GPU processing](gpu-processing.md) for batching, invalidation, and profiling.
