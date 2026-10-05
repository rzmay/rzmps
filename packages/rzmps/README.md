# RZMPS

**🧅 Robert May Particle System** is a modular, extensible particle system for
[Three.js](https://threejs.org/).

[![npm](https://img.shields.io/npm/v/@rzmps/rzmps)](https://www.npmjs.com/package/@rzmps/rzmps)
[![license](https://img.shields.io/npm/l/@rzmps/rzmps)](https://github.com/rzmay/rzmps)

| Resource    | Link                                                                         |
| ----------- | ---------------------------------------------------------------------------- |
| npm package | [npmjs.com/package/@rzmps/rzmps](https://www.npmjs.com/package/@rzmps/rzmps) |
| GitHub repo | [github.com/rzmay/rzmps](https://github.com/rzmay/rzmps)                     |
| Live demo   | [rzmps.rzmay.com](https://rzmps.rzmay.com)                                   |

RZMPS is built from small composable pieces:

- **Emitters** create particles from shapes.
- **Modules** modify particles over time.
- **Spatial effects** modify particles from scene-space volumes or custom tests.
- **Renderers** decide how particles appear in a Three.js scene.
- **Subsystems** let particles emit other particle systems.
- **Physics backends** let particles collide with Three.js objects or external
  physics engines.

## Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Core Types](#core-types)
- [Particle Systems](#particle-systems)
- [Emitters](#emitters)
- [Modules](#modules)
- [Spatial Effects](#spatial-effects)
  - [KillZone](#killzone)
  - [BoidAffector](#boidaffector)
- [Built-In Modules](#built-in-modules)
- [Built-In Renderers](#built-in-renderers)
- [Force Fields](#force-fields)
- [Collision And Physics](#collision-and-physics)
- [Custom Modules](#custom-modules)
- [Benchmarks](#benchmarks)
- [Developer Guide](#developer-guide)

## Installation

```bash
npm install @rzmps/rzmps three
```

`three` is a peer dependency.

## Quick Start

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
    rate: 80,
    radialSpeed: 2,
    initialValues: {
      lifetime: 1.5,
      scale: new THREE.Vector3(0.25, 0.25, 0.25),
      color: new THREE.Color("#ff9f43"),
    },
  }),
  modules: [
    new ColorOverLifetime({
      alpha: (t) => 1 - t,
    }),
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

## Core Types

### Dynamic Values

Many RZMPS options use `DynamicValue<T>`.

```ts
type DynamicValue<T> =
  | T
  | ((t: number) => DynamicValue<T>)
  | [DynamicValue<T>, DynamicValue<T>]
  | Set<DynamicValue<T>>;

// Used for parameters that can take multiple elements or just one
type Multiple<T> = T | T[];

// Multiple with least one value
type StrictMultiple<T> = T | [T, ...[T]];

// In RZMPS, tags are natively strings
type Tag = string;
```

The `t` argument is normalized particle lifetime, from `0` to `1`.

| Form           | Example                       | Behavior                               |
| -------------- | ----------------------------- | -------------------------------------- |
| Static value   | `2`                           | Always returns the same value.         |
| Function       | `(t) => 1 - t`                | Re-evaluates over normalized lifetime. |
| Two-item array | `[0.5, 2]`                    | Random value between min and max.      |
| Set            | `new Set(["spark", "smoke"])` | Random choice.                         |

Dynamic values are supported for numbers, vectors, and colors where the option
type uses `DynamicValue<number>`, `DynamicValue<THREE.Vector3>`, or
`DynamicValue<THREE.Color>`.

The [curves](https://www.npmjs.com/package/curves) package was designed and
built to streamline functional values by defining and evaluating eased curves,
similar to Unity's AnimationCurves with modifiers akin to Blender's FCurve
Modifiers. It has prebuilt keyframe types for numbers, colors, and vectors,
compatible with the `THREE.Vector3` and `THREE.Color` types.

### Tags

Emitters can assign tags to particles. Modules and renderers can filter by tags.

```ts
const emitter = new Emitter({
  tags: ["spark", "hot"],
  tagSelection: "all",
});

const sparksOnly = new SpriteRenderer(undefined, { tags: "spark" });
const fadeHot = new ColorOverLifetime({ tags: "hot", alpha: (t) => 1 - t });
```

`tagSelection` can follows the `TagSelectionMethod` enum, and can be:

```ts
enum TagSelectionMethod {
  All = "all",
  Random = "random",
  Distribute = "distribute",
}
```

| Value        | Behavior                                                 |
| ------------ | -------------------------------------------------------- |
| `All`        | Every emitted particle receives every emitter tag.scene. |
| `Random`     | Each particle receives one random tag.                   |
| `Distribute` | Tags are assigned round-robin.                           |

GPU processing encodes GPU-visible tag filters as a per-`ParticleSystem`
32-bit mask. CPU processing and CPU-only effects still support any number of
string tags, but GPU processing falls back to CPU when more than 32 distinct
tags are referenced by GPU module filters and renderer filters.

## Particle Systems

`ParticleSystem` extends `THREE.Object3D`, so it can be added, moved, rotated,
and scaled like any other Three.js object.

```ts
new ParticleSystem(options?: Partial<ParticleSystemOptions>)
```

```ts
interface ParticleSystemOptions {
  emitters: Multiple<Emitter>;
  renderers: Multiple<Renderer>;
  modules: Multiple<Module>;
  spatialEffects: Multiple<SpatialEffect>;
  spatialEffectFilter: (spatialEffect: SpatialEffect) => boolean;
  useSpatialEffects: boolean;
  simulationSpeed: number;
  duration: number;
  prewarm: boolean;
  prewarmFPS: number;
  looping: boolean;
  endBehavior: EndBehavior;
  maxParticles: number;
  maxCullingMode: MaxCulling;
  simulationDistance: number;
  useUpdateLOD: boolean;
  updateLOD: Partial<LODSettings>;
  gravity: THREE.Vector3;
  gravityModifier: DynamicValue<number>;
  inheritVelocity: number;
  simulationSpace: SimulationSpace;
  useLiveCubemap: boolean;
  cubemapSettings: Partial<LiveCubemapOptions>;
  gpuProcessing: boolean;
}
```

`duration` and `looping` control the particle system's emission timeline.
Emitters use normalized system time for rate curves and bursts.

Set `prewarm: true` to simulate one full `duration` cycle before the system
first renders. `prewarmFPS` controls the fixed warmup step rate and defaults to
`24`, which keeps the warmup inexpensive while avoiding an empty first frame.

Set `simulationDistance` above `0` to pause simulation while the particle system
is farther than that distance from the active camera. The default is `0`, which
disables distance limiting.

Set `gpuProcessing: true` to allow WebGPU particle updates when every
non-effect module in the system can use GPU particle buffers. Renderers that
support GPU input can consume those buffers directly; CPU-only renderers use
the CPU particle mirror after GPU readback.
`particleSystem.isGPUProcessingActive` reports whether the current update is
actually using the GPU path after fallback checks.

Set `inheritVelocity` above `0` to add the particle system's parent-transform
velocity to newly emitted top-level particles. `1` applies the full transform
velocity and fractional values apply a scaled amount. This uses the same
emission-context velocity path as subsystem velocity inheritance.

Generic spatial effects are enabled by default. The particle system discovers
generic `SpatialEffect` instances in its scene and also accepts an explicit
`spatialEffects` list. Use `spatialEffectFilter` to restrict which generic
effects a system responds to, or set `useSpatialEffects: false` to opt out.

Set `updateLOD` to reduce simulation frequency as systems move farther from the
active camera. `useUpdateLOD` defaults to `true` when `updateLOD` is provided
and `false` otherwise. Internally, `LODHelper` evaluates `LODSettings` with
discrete levels by default, or continuous multipliers with `continuous: true`.

```ts
new ParticleSystem({
  useUpdateLOD: true,
  updateLOD: {
    distance: 10,
    quality: 0.5,
    falloff: 2,
    maxLevel: 4,
    continuous: false,
  },
});
```

With `distance: 10` and `falloff: 2`, level 1 begins at 10 units and level 2
begins at 100 units. `quality` controls the update multiplier per level, so
`quality: 0.5` updates roughly every 2 frames at level 1 and every 4 frames at
level 2. Skipped time is accumulated into the next processed update so the
effect runs less often without intentionally slowing down. Emitters, modules,
and renderers also accept `useUpdateLOD` and `updateLOD` for per-component
update-frequency LOD.

Set `useLiveCubemap: true` to render a live environment map from the particle
system and feed it to sprite renderers using `material: "lit"`, mesh renderers,
and trail renderers. `cubemapSettings` accepts `LiveCubemapOptions` such as
`fps`, `resolutionScale`, and `intensity`.

`LiveCubemap` is also exported for utility use outside `ParticleSystem`. It is
primarily an internal helper, but can be attached to any `THREE.Object3D` with
`setup(parent)` and updated with `update(scene, renderer, deltaTime)` when you
need a local realtime cubemap. Set `excludeParent: true` to hide the parent
object while the cubemap is rendered, which is useful for reflective objects
that should not capture themselves.

```ts
new LiveCubemap(options?: Partial<LiveCubemapOptions>)

interface LiveCubemapOptions {
  resolutionScale: number;
  fps: number;
  intensity: number;
  excludeParent: boolean;
  excludeParticleRenderers: boolean;
}
```

| Option                     | Description                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `resolutionScale`          | Multiplies the renderer size before choosing the cubemap face resolution. Defaults to `1/16`.       |
| `fps`                      | Maximum cubemap update rate. Defaults to `24`.                                                      |
| `intensity`                | Reflection intensity used when particle renderers consume the cubemap. Defaults to `1`.             |
| `excludeParent`            | Hides the parent from the cubemap color/depth pass so reflective objects do not capture themselves. |
| `excludeParticleRenderers` | Hides particle renderer objects while the cubemap is rendered. Defaults to `false`.                 |

| Member                                    | Description                                          |
| ----------------------------------------- | ---------------------------------------------------- |
| `map`                                     | The generated cubemap texture, if initialized.       |
| `setup(parent)`                           | Attaches the cubemap helper to an object.            |
| `update(scene, renderer, deltaTime)`      | Updates the cubemap when its `fps` interval elapses. |
| `dispose()`                               | Disposes the cubemap render target.                  |
| `LiveCubemap.isLiveCubemapCamera(camera)` | Returns `true` for cameras used by this helper.      |

WebGL renders `SpriteRenderer` particles with `gl.POINTS`, whose size is
implementation-limited by `ALIASED_POINT_SIZE_RANGE`. In WebGL live cubemaps,
sprite particles may render as undersized point samples on some GPUs/drivers.
Use WebGPU when sprite particles need to appear correctly in live cubemap
reflections, or use mesh/trail renderers for reflected particles in WebGL.

For non-looping systems, `endBehavior` controls what happens after the system
duration has elapsed.

```ts
enum EndBehavior {
  None = "none",
  Destroy = "destroy",
  DestroyImmediate = "destroyImmediate",
}
```

| Value              | Behavior                                                              |
| ------------------ | --------------------------------------------------------------------- |
| `None`             | Stops emission and keeps the system in the scene.                     |
| `Destroy`          | Stops emission, lets live particles finish, then destroys the system. |
| `DestroyImmediate` | Destroys the system as soon as its duration elapses.                  |

### Max Particles

`maxParticles` caps the number of live particles in the system. When the cap is
exceeded, `maxCullingMode` controls which particles are removed.

```ts
enum MaxCulling {
  New = "new",
  Old = "old",
}
```

| Value | Behavior                                                                  |
| ----- | ------------------------------------------------------------------------- |
| `New` | Keeps the existing particles and discards particles after `maxParticles`. |
| `Old` | Removes particles from the front of the particle list first.              |

Particle age is determined by list order for speed, rather than by comparing
lifetime values.

### Simulation Space

`simulationSpace` follows the `SimulationSpace` enum and controls whether
particle positions are stored relative to the particle system or in world space.

```ts
enum SimulationSpace {
  Local = "local",
  World = "world",
}
```

| Value   | Behavior                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------- |
| `Local` | Particles move with the particle system transform.                                             |
| `World` | New particles spawn from the system transform, then remain in world space if the system moves. |

Subsystems inherit the parent system's simulation space.

### Control Methods

| Method                                  | Description                                                  |
| --------------------------------------- | ------------------------------------------------------------ |
| `update()`                              | Advances the particle system. Call once per animation frame. |
| `start(children = true)`                | Starts or restarts emission.                                 |
| `pause(children = true)`                | Pauses emission and simulation.                              |
| `stop(clearParticles, children = true)` | Stops emission; optionally clears existing particles.        |
| `destroy(children = true)`              | Stops, clears, destroys renderers, and removes the system.   |
| `clearParticles(children = true)`       | Removes all live particles.                                  |
| `addEmitter(emitter)`                   | Adds and sets up an emitter.                                 |
| `addModule(module)`                     | Adds a module.                                               |
| `addRenderer(renderer)`                 | Adds and sets up a renderer.                                 |
| `addSubSystem(system, options)`         | Adds a child particle system emitted by particles.           |

For control methods with a `children` argument, `true` propagates the same
action to child `ParticleSystem` objects in the Three.js hierarchy. Subsystems
registered through `addSubSystem` are managed separately and are not treated as
hierarchy children for this propagation.

Use the read-only `playing`, `paused`, and `ended` properties to inspect control
state and decide whether your application should call `start()`.

### Event Listeners

`ParticleSystem` exposes listener helpers for particle lifecycle events.

```ts
type ParticleListener = (particle: Particle) => void;
type CollisionListener = (particle: Particle, collision: CollisionHit) => void;

system.onSpawn((particle) => {
  console.log("spawned", particle.id);
});

system.onDeath((particle) => {
  console.log("died", particle.id);
});

system.onCollision((particle, collision) => {
  console.log("hit", particle.id, collision);
});
```

| Method                              | Description                                           |
| ----------------------------------- | ----------------------------------------------------- |
| `onSpawn(listener)`                 | Runs when a particle is emitted.                      |
| `removeSpawnListener(listener)`     | Removes a spawn listener.                             |
| `onDeath(listener)`                 | Runs when a particle reaches the end of its lifetime. |
| `removeDeathListener(listener)`     | Removes a death listener.                             |
| `onCollision(listener)`             | Runs when the `Collision` module reports a hit.       |
| `removeCollisionListener(listener)` | Removes a collision listener.                         |

### Subsystems

```ts
interface SubSystemOptions {
  shouldEmit: boolean | ((particle: Particle) => boolean);
  ratio: number;
  emitContinuous: boolean;
  emitOnCollision: boolean;
  emitOnSpawn: boolean;
  emitOnDeath: boolean;
  inheritScale: number;
  inheritLifetime: number;
  inheritColor: number;
  inheritAlpha: number;
  inheritMass: number;
  inheritVelocity: number;
  impulseAffectsScale: number;
  impulseAffectsSpeed: number;
  impulseAffectsLifetime: number;
  impulseAffectsMass: number;
  impulseAffectsAlignment: boolean;
  impulseThreshold: number;
}
```

```ts
rocketSystem.addSubSystem(sparkSystem, {
  emitOnDeath: true,
  emitContinuous: false,
  inheritColor: 1,
  inheritAlpha: 1,
  inheritScale: 1,
  inheritVelocity: 0.5,
  impulseAffectsScale: 0.35,
  impulseAffectsAlignment: true,
  impulseThreshold: 0.2,
});
```

Inheritance options are numeric blend amounts. `0` disables inheritance, `1`
fully applies the parent particle value, and values between blend between the
neutral child-authored value and the parent particle value. `inheritVelocity`
adds a scaled parent velocity to newly spawned subsystem particles and defaults
to `0`, so subsystems keep their own authored velocity unless requested.

Subsystems are owned and updated by their parent. They can emit continuously
from parent particles, or trigger emission runs on spawn, collision, or death.
For collision-triggered emission runs, impulse effect values use
`Math.pow(collision.impulse.length(), effect)`. Scale, speed, and mass use that
result as a multiplier. Lifetime adds that result to the emission run duration.
Alignment rotates the emission so its up axis follows the collision impulse.
`impulseThreshold` defaults to `0`; collision-triggered runs only start when
`collision.impulse.length() > impulseThreshold`.

### Textures

RZMPS exports built-in texture URLs for common sprite and trail renderers:

```ts
import { Textures } from "@rzmps/rzmps";

new SpriteRenderer(Textures.Circle);
```

| Export             | Description                 |
| ------------------ | --------------------------- |
| `Textures.Default` | Default particle sprite.    |
| `Textures.Circle`  | Circular particle sprite.   |
| `Textures.Simple`  | Simple soft circle texture. |

## Emitters

```ts
new Emitter(options?: Partial<EmitterOptions>)
```

```ts
type SpawnBurst = {
  time: number;
  count: DynamicValue<number>;
};

interface EmitterOptions {
  initialValues: Partial<InitialParticleValues>;
  source: EmissionShape;
  bursts: SpawnBurst | SpawnBurst[];
  rate: DynamicValue<number>;
  rateOverDistance: DynamicValue<number>;
  radialSpeed: DynamicValue<number>;
  alignment: DynamicValue<number>;
  tags: StrictMultiple<Tag>;
  tagSelection: TagSelectionMethod;
  useUpdateLOD: boolean;
  updateLOD: Partial<LODSettings>;
  countLOD: Partial<LODSettings>;
}
```

Emitter `rate` curves, `rateOverDistance` curves, and burst `time` values are
evaluated against the owning particle system's normalized timeline.

`rateOverDistance` emits particles based on travel distance instead of elapsed
time. A value of `2` emits two particles per unit moved. For continuous
subsystems, distance is measured from the parent particle transform so trails
follow the emitting particle rather than the subsystem object.

`updateLOD` controls emitter update frequency. `countLOD` scales emission rate
distance emission, and burst counts without skipping the emitter update
entirely.

Internally, emitters use a single update entry point:

```ts
emitter.update(
  particles,
  context: Partial<EmissionContext>,
  particleSystem,
  deltaTime,
);
```

`EmissionContext` carries only per-emission overrides such as subsystem keys,
parent transforms, inherited lifetime timing, inherited color/alpha/mass,
velocity/scale impulse multipliers, and tags. Defaults such as duration,
looping, camera distance, and the current delta time come from the owning
`ParticleSystem`.

### Initial Particle Values

Common `initialValues` fields include:

| Field                 | Type            | Description                                                        |
| --------------------- | --------------- | ------------------------------------------------------------------ |
| `position`            | `THREE.Vector3` | Initial particle position. Usually supplied by the emission shape. |
| `rotation`            | `THREE.Vector3` | Initial Euler rotation.                                            |
| `scale`               | `THREE.Vector3` | Initial particle scale.                                            |
| `velocity`            | `THREE.Vector3` | Initial linear velocity.                                           |
| `angularVelocity`     | `THREE.Vector3` | Initial rotational velocity.                                       |
| `scalarVelocity`      | `THREE.Vector3` | Initial scale velocity.                                            |
| `acceleration`        | `THREE.Vector3` | Initial linear acceleration.                                       |
| `angularAcceleration` | `THREE.Vector3` | Initial rotational acceleration.                                   |
| `scalarAcceleration`  | `THREE.Vector3` | Initial scale acceleration.                                        |
| `lifetime`            | `number`        | Lifetime in seconds.                                               |
| `speed`               | `number`        | Multiplier applied to particle simulation speed.                   |
| `color`               | `THREE.Color`   | Initial particle color.                                            |
| `alpha`               | `number`        | Initial opacity.                                                   |
| `mass`                | `number`        | Particle mass for collision impulses. Defaults to `0`.             |

Most initial values can be dynamic. On the GPU path, TSL nodes can be supplied
directly. JavaScript functions are sampled into a uniform lookup table and
interpolated; adjust `ParticleSystem.GPU_DYNAMIC_VALUE_RESOLUTION` to trade
curve fidelity for uniform data size. TSL nodes are GPU-only and throw if a CPU
evaluator receives them.

### Emission Shapes

```ts
new EmissionShape(options?: Partial<EmissionShapeOptions>)
```

```ts
interface EmissionShapeOptions {
  geometry: THREE.BufferGeometry;
  source: EmissionSource;
}

enum EmissionSource {
  Volume = "volume",
  Surface = "surface",
  Vertices = "vertices",
}
```

Helpers:

```ts
EmissionShape.Box(...boxGeometryArgs);
EmissionShape.Box(options, ...boxGeometryArgs);
EmissionShape.Sphere(...sphereGeometryArgs);
EmissionShape.Sphere(options, ...sphereGeometryArgs);
EmissionShape.Cone(...coneGeometryArgs);
EmissionShape.Cone(options, ...coneGeometryArgs);
EmissionShape.Torus(...torusGeometryArgs);
EmissionShape.Torus(options, ...torusGeometryArgs);
```

Factory `options` use `Partial<Omit<EmissionShapeOptions, "geometry">>`, so
the helper factories can set fields like `source` while still constructing the
underlying geometry from the remaining arguments.

When `source` is `EmissionSource.Volume`, the shape samples random points in
the geometry's bounding box and tests whether each point is inside the geometry.
`EmissionShape.MAX_VOLUME_ITERATIONS` controls how many points one call will try
before falling back to surface emission. It defaults to `5`.

## Modules

All modules extend `Module`. Constructor option objects are partials, so you
only need to pass the fields you want to customize.

```ts
interface ModuleOptions {
  priority: number | Module.Priority;
  tags: StrictMultiple<Tag>;
  condition: (particle: Particle) => boolean;
  conditionGPU: ModuleGPUUpdate | null;
  useUpdateLOD: boolean;
  updateLOD: Partial<LODSettings>;
  modifyGPU: ModuleGPUUpdate | null;
  spatialEffects: SpatialEffect[];
  spatialEffectFilter: (spatialEffect: SpatialEffect) => boolean;
  requireSpatialEffects: typeof SpatialEffect | Array<typeof SpatialEffect>;
}
```

`updateLOD` controls module update frequency. It skips the module's particle
work on lower-detail frames while preserving the module API.

| Option      | Description                                                                                                                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `priority`  | Controls the module phase. Priorities below `0` are permanent pre-movement updates, priorities from `0` to below `1` are transient pre-movement updates, and priorities `1` or higher are transient render-time updates. Modules are sorted by priority inside each phase. |
| `tags`      | Restricts the module to particles with matching tags.                                                                                                                                                                                                                      |
| `condition` | Optional per-particle predicate called before modification. Return `false` to skip that particle.                                                                                                                                                                          |
| `conditionGPU` | Optional GPU predicate hook for modules that support GPU processing. |
| `modifyGPU` | Optional GPU implementation. Modules without `modifyGPU` keep the system on the CPU path. |

Modules can also discover scene-level `SpatialEffect` objects. Pass
`requireSpatialEffects` to select the spatial effect class a module consumes,
`spatialEffects` for an explicit list, or `spatialEffectFilter` for additional
filtering. Module update functions receive
`(particle, deltaTime,
particleSystem)`; existing two-argument functions
continue to work.

Common priority values are exposed on `Module.Priority`:

```ts
Module.Priority.Permanent; // -1
Module.Priority.PreMovementTransient; // 0.5
Module.Priority.Transient; // 1
```

Priority also determines whether a module's changes persist into the next frame.
Permanent pre-movement changes are cached into the next persistent particle
state. Transient pre-movement modules can affect the current movement step
without accumulating their direct edits across frames, and transient render-time
modules can tint, fade, or scale particles for rendering without overwriting
persistent state. Collision modules use a late permanent pre-movement priority
so they can predict the current frame's travel segment and resolve velocity
before movement.

## Spatial Effects

`SpatialEffect` is a scene-space object for effects that occupy a volume or use
a custom spatial test. By default it tests whether a particle is inside its
geometry, respecting `inverted` and `tags`. You can also pass a custom `test`
function. Use `condition` when the spatial range test should stay separate from
the per-particle rule for whether the effect should operate.

```ts
interface SpatialEffectOptions {
  position: THREE.Vector3;
  scale: THREE.Vector3;
  geometry: THREE.BufferGeometry;
  inverted: boolean;
  tags: StrictMultiple<Tag>;
  condition: (particle: Particle) => boolean;
  test: (
    particle: Particle,
    particleSystem: ParticleSystem,
    effect: SpatialEffect,
  ) => boolean;
  priority: number | Module.Priority;
  feather: number;
  featherEasing: (feather: number) => number;
  automaticFeather: boolean;
}
```

Spatial effects come in two flavors:

- Generic spatial effects directly mutate particles in `modify(...)`. Use them
  when the spatial object itself contains all the behavior. The particle system
  discovers generic spatial effects in its scene automatically, or you can pass
  them directly with `spatialEffects`.
- Domain-specific spatial effects expose specialized APIs and are consumed by a
  matching module. This is useful when the spatial object only describes
  queryable scene data and a module owns the particle behavior.

```ts
const zone = KillZone.Sphere({ tags: "killable" }, 2, 32, 16);
scene.add(zone);
```

Plane tests are useful for kill planes and other half-space effects:

```ts
const killPlane = new KillZone({
  tags: "killable",
  test: SpatialEffect.Plane({
    position: new THREE.Vector3(0, -2, 0),
    normal: new THREE.Vector3(0, 1, 0),
  }),
});
```

Use `SpatialEffectHelper` to visualize generic spatial effect geometry.
`ParticleForceFieldHelper` extends it with sampled force arrows.

To create a generic spatial effect, pass a modifier function as the first
constructor argument. The base class handles scene placement, geometry
containment, `inverted`, `tags`, priority, feathering, and custom tests. Generic
spatial effects default to `Module.Priority.Transient`; effects that should
persist into particle state can opt into `Module.Priority.Permanent`.

```ts
const color = new THREE.Color("#ffd166");

scene.add(
  new SpatialEffect((particle) => {
    particle.color.lerp(color, 0.2);
  }, {
    geometry: new THREE.SphereGeometry(2, 32, 16),
    priority: Module.Priority.Transient,
    feather: 1,
  }),
);
```

When `feather` is greater than `0`, the effect extends beyond its geometry by
that many world units and returns a normalized boundary strength. A particle on
the original surface receives strength `1`, and the strength fades to `0` at the
outer feather edge. For automatic feathering, particles in this softened edge
are blended between their pre-effect and post-effect values using
`Particle.lerp(...)`.

Use `featherEasing` to reshape that normalized `0..1` feather strength. It can
be any function receiving the linear feather value and returning a new strength.
For example, with [eaz](https://www.npmjs.com/package/eaz):

```ts
import { Easing } from "eaz";

new SpatialEffect((particle) => {
  particle.scale.multiplyScalar(2);
}, {
  geometry: new THREE.SphereGeometry(2),
  feather: 1,
  featherEasing: Easing.cubic.inOut,
});
```

Set `automaticFeather: false` when you want the eased strength value directly
instead of automatic clone/lerp blending:

```ts
new SpatialEffect((particle, deltaTime, particleSystem, feather) => {
  particle.alpha *= feather;
}, {
  geometry: new THREE.SphereGeometry(2),
  feather: 1,
  automaticFeather: false,
});
```

To create a domain-specific effect, extend `SpatialEffect` but expose methods
for a matching module to consume. The module should pass `requireSpatialEffects`
and then use `this.spatialEffects` in `prepare` or `modify`. See
[Developing With Spatial Effects](#developing-with-spatial-effects) for a module
extension example.

### KillZone

```ts
new KillZone(options?: Partial<KillZoneOptions>)
KillZone.Box(options, ...boxGeometryArgs)
KillZone.Sphere(options, ...sphereGeometryArgs)
KillZone.Cone(options, ...coneGeometryArgs)
KillZone.Torus(options, ...torusGeometryArgs)

type KillZoneOptions = SpatialEffectOptions;
```

Kills particles that pass its spatial test by calling `particle.kill()`.
`KillZone` runs at permanent priority by default so killed particles are
compacted immediately. Geometry kill zones use the default inside-geometry test;
plane kill zones can be created with `SpatialEffect.Plane(...)`.

```ts
const killPlane = new KillZone({
  tags: "debris",
  test: SpatialEffect.Plane({
    position: new THREE.Vector3(0, -2, 0),
    normal: new THREE.Vector3(0, 1, 0),
  }),
});
```

### BoidAffector

```ts
new BoidAffector(options?: Partial<BoidAffectorOptions>)
BoidAffector.Box(options, ...boxGeometryArgs)
BoidAffector.Sphere(options, ...sphereGeometryArgs)
BoidAffector.Cone(options, ...coneGeometryArgs)
BoidAffector.Torus(options, ...torusGeometryArgs)

interface BoidAffectorOptions extends Omit<SpatialEffectOptions, "test"> {
  weight: number;
  distance: number;
  range: number;
  bvhOptions: MeshBVHOptions;
}
```

`BoidAffector` is a domain-specific spatial effect consumed by the `Boids`
module. Positive weights pull boids toward the sampled point and negative
weights push them away. Use `BoidAffector.Weight.Target` (`1`) and
`BoidAffector.Weight.Obstacle` (`-1`) for the common cases.

`distance` is the preferred clearance from the affector surface. `range` is a
world-space optimization radius around the affector origin; particles outside
that radius skip the affector before expensive surface sampling. For geometry
affectors, choose a `range` large enough to cover the geometry radius plus the
surface influence band you want. If `range` is omitted, the default is estimated
from the geometry bounding box plus:

```ts
Math.sqrt(Math.abs(weight) / BoidAffector.RANGE_INFLUENCE_THRESHOLD)
```

`BoidAffector.RANGE_INFLUENCE_THRESHOLD` defaults to `1e-6`. Lower values keep
weaker distant influence and increase query cost. Higher values shorten the
default range, improving performance at the cost of ignoring weaker distant
influence. Explicit `range` values bypass that default estimate.

When an affector has geometry, it builds a `three-mesh-bvh` acceleration
structure and samples the closest surface point instead of its object position.
`Box`, `Sphere`, `Cone`, and `Torus` are provided as geometry shorthands. Set
`inverted: true` to invert the sampled influence direction; paired with obstacle
weights, this is useful for containment volumes. Tags and `condition` are
supported, but custom `test` is not supported for `BoidAffector`; use
`condition`, `tags`, or a `Boids` `affectorFilter` when you need extra
selection logic. Feathering is ignored because boid influence already uses
distance-based falloff.

## Built-In Modules

### VelocityOverLifetime

```ts
new VelocityOverLifetime(options?: Partial<VelocityOverLifetimeOptions>)

interface VelocityOverLifetimeOptions extends Partial<ModuleOptions> {
  position: DynamicVector3;
  linear: DynamicVector3;
  acceleration: DynamicVector3;
  orbital: DynamicVector3;
  orbitOffset: DynamicVector3;
  radial: DynamicValue<number>;
  speedModifier: DynamicValue<number>;
}
```

Adds optional position, linear velocity, acceleration, orbital, and radial
terms. `speedModifier` multiplies particle simulation speed.

### ForceOverLifetime

```ts
new ForceOverLifetime(options: ForceOverLifetimeOptions)

interface ForceOverLifetimeOptions extends Partial<ModuleOptions> {
  force: DynamicVector3;
}
```

Adds a dynamic force to particle acceleration.

### LimitVelocityOverLifetime

```ts
new LimitVelocityOverLifetime(options: LimitVelocityOverLifetimeOptions)

interface LimitVelocityOverLifetimeOptions extends Partial<ModuleOptions> {
  limit: DynamicVector3;
  dampen?: number;
  drag?: DynamicValue<number>;
  multiplyDragBySize?: boolean;
  multiplyDragByVelocity?: boolean;
}
```

Clamps velocity per axis and optionally applies drag.

### MassOverLifetime

```ts
new MassOverLifetime(options: MassOverLifetimeOptions)

interface MassOverLifetimeOptions extends Partial<ModuleOptions> {
  mass: DynamicValue<number>;
  multiplyMassBySize: boolean;
}
```

Changes particle mass over lifetime. `multiplyMassBySize` defaults to `true`.

### SpeedOverLifetime

```ts
new SpeedOverLifetime(options?: {
  speed: DynamicValue<number>;
})
```

Multiplies particle speed over lifetime. This is equivalent to
`VelocityOverLifetime`'s `speedModifier`, but is available as a dedicated module
for the standard parameter roster.

### ColorOverLifetime

```ts
new ColorOverLifetime(options?: ColorOverLifetimeOptions)

interface ColorOverLifetimeOptions extends Partial<ModuleOptions> {
  color?: DynamicColor;
  alpha?: DynamicValue<number>;
}
```

Multiplies each particle's current-frame color and alpha over lifetime.

### ColorBySpeed

```ts
new ColorBySpeed(options: ColorBySpeedOptions)

type SpeedRange = [number, number] | { min: number; max: number };
type ValueByParameter<T> =
  | T
  | ((t: number) => ValueByParameter<T>)
  | [ValueByParameter<T>, ValueByParameter<T>];

interface ColorBySpeedOptions extends Partial<ModuleOptions> {
  color?: ColorByParameter;
  alpha?: ValueByParameter<number>;
  speedRange?: SpeedRange;
}
```

Multiplies current-frame color and alpha based on normalized speed within
`speedRange`. For `ValueByParameter`, a tuple interpolates between its endpoint
values by the normalized parameter, a standalone constant scales by the
parameter, and a function receives the parameter and returns the exact value to
use.

### Size Modules

Size modules use `particle.scale.length()` normalized into `sizeRange`.

```ts
type SizeRange = [number, number] | { min: number; max: number };

new ColorBySize(options?: {
  color?: ColorByParameter;
  alpha?: ValueByParameter<number>;
  sizeRange?: SizeRange;
})

new RotationBySize(options?: {
  angle?: Vector3ByParameter;
  angularVelocity?: Vector3ByParameter;
  angularAcceleration?: Vector3ByParameter;
  sizeRange?: SizeRange;
})

new VelocityBySize(options?: {
  position?: Vector3ByParameter;
  velocity?: Vector3ByParameter;
  acceleration?: Vector3ByParameter;
  sizeRange?: SizeRange;
})

new SpeedBySize(options?: {
  speed?: ValueByParameter<number>;
  sizeRange?: SizeRange;
})

new MassBySize(options?: {
  mass?: ValueByParameter<number>;
  sizeRange?: SizeRange;
})

new DistortionBySize(options?: {
  distortionStrength?: ValueByParameter<number>;
  sizeRange?: SizeRange;
})
```

These are useful when visual or physical behavior should react to particle size
after other transient scale modules have run.

### Depth Modules

Depth modules use camera distance normalized into `depthRange`. If no
`depthRange` is provided, the active camera's `near` and `far` values are used.

```ts
type DepthRange = [number, number];

new ColorByDepth(options?: {
  color?: ColorByParameter;
  alpha?: ValueByParameter<number>;
  depthRange?: DepthRange;
})

new ScaleByDepth(options?: {
  scale?: Vector3ByParameter;
  scalarVelocity?: Vector3ByParameter;
  scalarAcceleration?: Vector3ByParameter;
  depthRange?: DepthRange;
})

new RotationByDepth(options?: {
  angle?: Vector3ByParameter;
  angularVelocity?: Vector3ByParameter;
  angularAcceleration?: Vector3ByParameter;
  depthRange?: DepthRange;
})

new VelocityByDepth(options?: {
  position?: Vector3ByParameter;
  velocity?: Vector3ByParameter;
  acceleration?: Vector3ByParameter;
  depthRange?: DepthRange;
})

new SpeedByDepth(options?: {
  speed?: ValueByParameter<number>;
  depthRange?: DepthRange;
})

new MassByDepth(options?: {
  mass?: ValueByParameter<number>;
  depthRange?: DepthRange;
})

new DistortionByDepth(options?: {
  distortionStrength?: ValueByParameter<number>;
  depthRange?: DepthRange;
})
```

These are useful with `SpriteRenderer` `sizeAttenuation: false` when you want
explicit stylistic control over color, scale, distortion, motion, or timing
across camera depth.

### ScaleOverLifetime

```ts
new ScaleOverLifetime(options: ScaleOverLifetimeOptions)

interface ScaleOverLifetimeOptions extends Partial<ModuleOptions> {
  scale: DynamicVector3;
  scalarVelocity: DynamicVector3;
  scalarAcceleration: DynamicVector3;
}
```

Multiplies each particle's current-frame scale over lifetime and can add scalar
velocity or scalar acceleration.

### Distortion Modules

```ts
new DistortionOverLifetime(options?: {
  distortionStrength?: DynamicValue<number>;
})

new DistortionBySpeed(options?: {
  distortionStrength?: ValueByParameter<number>;
  speedRange?: SpeedRange;
})

new DistortionByDepth(options?: {
  distortionStrength?: ValueByParameter<number>;
  depthRange?: DepthRange;
})
```

Multiplies each particle's `distortionStrength`, which acts as a per-particle
multiplier for the `SpriteRenderer` material `distortionStrength` before
sampling the transmitted scene color.

### ScaleBySpeed

```ts
new ScaleBySpeed(options: ScaleBySpeedOptions)

interface ScaleBySpeedOptions extends Partial<ModuleOptions> {
  scale: Vector3ByParameter;
  scalarVelocity: Vector3ByParameter;
  scalarAcceleration: Vector3ByParameter;
  speedRange?: SpeedRange;
}
```

Multiplies current-frame scale and can add scalar velocity or scalar
acceleration based on normalized speed within `speedRange`.

### RotationOverLifetime

```ts
new RotationOverLifetime(options: RotationOverLifetimeOptions)

interface RotationOverLifetimeOptions extends Partial<ModuleOptions> {
  angle: DynamicVector3;
  angularVelocity: DynamicVector3;
  angularAcceleration: DynamicVector3;
}
```

Adds current-frame rotation, angular velocity, and angular acceleration over
lifetime. These changes are transient pre-movement edits, so they influence the
current movement step without accumulating direct angular velocity every frame.

### RotationBySpeed

```ts
new RotationBySpeed(options: RotationBySpeedOptions)

interface RotationBySpeedOptions extends Partial<ModuleOptions> {
  angle: Vector3ByParameter;
  angularVelocity: Vector3ByParameter;
  angularAcceleration: Vector3ByParameter;
  speedRange?: SpeedRange;
}
```

Adds current-frame rotation, angular velocity, and angular acceleration based on
normalized speed within `speedRange`.

### NoiseModule

```ts
new NoiseModule(key: string, options?: Partial<NoiseOptions>)

interface NoiseOptions extends Partial<ModuleOptions> {
  octaves: number;
  frequency: number;
  lacunarity: number;
  persistence: number;
  time: number;
  offset: THREE.Vector3;
}
```

Writes simplex noise into `particle.noise[key]` as `{ noise, noise4d }`.

### TransformByNoise

```ts
new TransformByNoise(options: Partial<TransformByNoiseOptions>)

interface TransformByNoiseOptions extends Partial<ModuleOptions>, NoiseOptions {
  strength: DynamicVector3;
  scrollSpeed: DynamicValue<number>;
  damping: boolean;
}
```

Pushes particles through animated 3D noise. Internally, it creates dependent
`NoiseModule` instances for the X, Y, and Z axes.

### Boids

```ts
new Boids(options?: Partial<BoidsOptions>)

interface BoidsOptions extends Partial<ModuleOptions> {
  octreeOptions: OctreeConfig;
  timeQuality: number;
  speed: DynamicValue<number>;
  alignmentWeight: DynamicValue<number>;
  cohesionWeight: DynamicValue<number>;
  separationWeight: DynamicValue<number>;
  affectorWeight: DynamicValue<number>;
  affectorDistance: DynamicValue<number>;
  steering: DynamicValue<number>;
  affectors: BoidAffector[];
  affectorFilter: (affector: BoidAffector) => boolean;
  particleAffectors: BoidParticleAffectorMap;
}
```

Steers particles using local flocking behavior sampled from a `ParticleOctree`.
`alignmentWeight` points particles toward nearby average velocity direction,
`cohesionWeight` points them toward nearby average position, and
`separationWeight` points them away from nearby aggregate centers.
`affectorWeight` controls response to `BoidAffector` objects. `speed` sets
the target boid speed; when omitted, each particle keeps its current velocity
magnitude. `steering` controls how quickly velocity lerps toward the boid
target.

`octreeOptions` is passed to the internal `ParticleOctree` constructor and
should cover the boid simulation space. If the Boids module has tags, those tags
are passed to the octree so flocking samples only include matching particles. If
`affectors` is omitted, `Boids` scans the scene for `BoidAffector` objects:

```ts
const target = new Boids.BoidAffector({
  position: new THREE.Vector3(3, 0, 0),
  weight: Boids.BoidAffector.Weight.Target,
});

const obstacle = Boids.BoidAffector.Sphere(
  {
    position: new THREE.Vector3(0, 0, 0),
    weight: Boids.BoidAffector.Weight.Obstacle,
    distance: 0.25,
    range: 4,
  },
  1,
  16,
  8,
);

new Boids({
  octreeOptions: {
    bounds: new THREE.Box3(
      new THREE.Vector3(-10, -10, -10),
      new THREE.Vector3(10, 10, 10),
    ),
    maxDepth: 4,
    maxParticlesPerLeaf: 8,
  },
  timeQuality: 0.5,
  affectors: [target, obstacle],
});
```

`particleAffectors` can treat particles with matching tags as temporary
affectors during octree aggregation. Object keys select source particles by tag;
use `|` or `,` for an OR-list. The mapped value accepts `weight`, `distance`,
and `tags` from `BoidAffectorOptions`: `weight` defaults to
`Boids.BoidAffector.Weight.Obstacle`, `distance` is multiplied by the source
particle's largest scale axis, and `tags` optionally filters which boids are
affected.

```ts
new Boids({
  particleAffectors: {
    predator: {
      tags: ["prey"],
      distance: 1.5,
    },
    "friend,leader": {
      tags: ["follower"],
      weight: Boids.BoidAffector.Weight.Target,
      distance: 1,
    },
  },
});
```

`timeQuality` follows the same accumulator pattern as `ParticleOctree`: `1`
rebuilds the octree every update, `0.5` rebuilds about every other update, and
lower values trade responsiveness for less CPU work.

See [BoidAffector](#boidaffector) for scene-level target, obstacle, container,
range, and optimization details.

### Collision

```ts
new Collision(options?: Partial<CollisionOptions>)

interface CollisionOptions extends Partial<ModuleOptions> {
  backend: ICollisionBackend;
  dampen: DynamicValue<number>;
  bounce: DynamicValue<number>;
  lifetimeLoss: DynamicValue<number>;
  applyImpulses: boolean;
  radiusScale: number;
  minKillSpeed: number;
  maxKillSpeed: number;
  onCollision?: CollisionListener;
}
```

Detects collisions using an `ICollisionBackend`, reflects velocity with bounce
and dampening, reduces lifetime on impact, and can apply impulses to dynamic
physics bodies when supported by the backend. `radiusScale` multiplies half of
the largest particle scale component to produce the collision radius; sprite
renderers draw particle scale in world units, so `radiusScale: 1` matches a
full-size circular sprite. Collision hits report `impulse` as the collision
normal multiplied by normal impact speed and particle mass, keeping
collision-triggered effects consistent across the built-in octree backend and
the external Rapier, Jolt, and Ammo backends.

Collision runs as a late permanent pre-movement module. It predicts each
particle's current-frame travel segment from position and velocity, resolves
position/velocity before movement, then lets the normal movement step carry the
particle away from the surface.

In GPU processing, collision queries are approximated on the CPU during
`prepare()` using the same current position and projected velocity. The sampled
hit position and normal are uploaded to GPU buffers and applied during the GPU
update. This keeps CPU collision backends available to GPU systems without
mixing CPU processing into the middle of the GPU pipeline.

## Built-In Renderers

All renderers accept shared renderer options:

```ts
interface RendererOptions {
  tags: StrictMultiple<Tag>;
  useUpdateLOD: boolean;
  updateLOD: Partial<LODSettings>;
  countLOD: Partial<LODSettings>;
  compensateSize: boolean;
}
```

`updateLOD` controls renderer update frequency. `countLOD` reduces the number of
particles submitted to the renderer. Set `compensateSize: true` to increase
rendered particle size by the inverse of the count LOD multiplier, which can
help maintain visual fullness when fewer particles are rendered.

Renderers can also be used for custom non-mutating effects. Extend `Renderer`
when you want to react to particle data without changing the simulation:

```ts
class LoggingEffect extends Renderer {
  setup(system: ParticleSystem) {}
  protected _update(
    particles: Particle[],
    system: ParticleSystem,
    deltaTime: number,
  ) {
    particles.forEach((particle) => console.log(particle.position));
  }
  destroy() {}
  clear() {}
}
```

### AudioRenderer

```ts
new AudioRenderer(options?: Partial<AudioRendererOptions>)

interface AudioRendererOptions extends Partial<RendererOptions> {
  listener: THREE.AudioListener;
  sound: AudioBuffer | AudioBuffer[];
  onCollisionSound: AudioBuffer | AudioBuffer[];
  onSpawnSound: AudioBuffer | AudioBuffer[];
  onDeathSound: AudioBuffer | AudioBuffer[];
  shouldPlay: (particle: Particle) => boolean;
  loop: boolean;
  maxClips: number;
  ratio: number;
  collisionRatio: number;
  pitch: DynamicValue<number>;
  volume: DynamicValue<number>;
  highPass: DynamicValue<number>;
  lowPass: DynamicValue<number>;
  sizeAffectsPitch: number;
  sizeAffectsVolume: number;
  sizeAffectsHighPass: number;
  sizeAffectsLowPass: number;
  alphaAffectsPitch: number;
  alphaAffectsVolume: number;
  alphaAffectsHighPass: number;
  alphaAffectsLowPass: number;
  speedAffectsPitch: number;
  speedAffectsVolume: number;
  speedAffectsHighPass: number;
  speedAffectsLowPass: number;
  depthAffectsPitch: number;
  depthAffectsVolume: number;
  depthAffectsHighPass: number;
  depthAffectsLowPass: number;
  dopplerEffect: number;
  impulseAffectsPitch: number;
  impulseAffectsVolume: number;
  impulseAffectsHighPass: number;
  impulseAffectsLowPass: number;
  impulseThreshold: number;
}
```

Adds positional audio to particles and can play event sounds for spawn,
collision, and death. `maxClips` defaults to `256` and limits the number of
simultaneous event clips from this renderer. Collision event sounds can use
`impulseAffectsPitch` and `impulseAffectsVolume`; each uses
`Math.pow(collision.impulse.length(), effect)` as a multiplier on the evaluated
pitch or volume. `highPass` and `lowPass` create Web Audio `BiquadFilterNode`
filters through Three.js. Pitch, volume, high-pass cutoff, and low-pass cutoff
can all be modulated by size, alpha, speed, depth, and collision impulse using
the corresponding `...Affects...` option. `dopplerEffect` modulates pitch from
listener-relative particle motion: `0` disables the effect, `1` is physically
scaled, and larger or fractional values exaggerate or soften the shift. Filters
are applied whenever their evaluated cutoff is greater than `0`.
`impulseThreshold` defaults to `0`; collision sounds only play when
`collision.impulse.length() > impulseThreshold`.

### SpriteRenderer

```ts
new SpriteRenderer(
  texture?: string | THREE.Texture,
  options?: Partial<SpriteRendererOptions>
)

interface SpriteRendererOptions extends RendererOptions {
  fps: DynamicValue<number>;
  billboard: boolean;
  sizeAttenuation: boolean;
  tileSize: { x: number; y: number };
  tileMargin: { x: number; y: number };
  gridSize: { x: number; y: number };
  frames: number;
  randomStartFrame: boolean;
  alphaMap: string | THREE.Texture;
  material: SpriteMaterialType;
  materialOptions: LitSpriteOptions | UnlitSpriteOptions;
  castShadow: boolean;
  softParticleDistance: number;
}
```

`SpriteRenderer` renders particles as GPU points in WebGL and camera-facing
instanced quads in WebGPU. It supports sprite sheets, alpha maps, random start
frames, shadows, and soft particles. WebGL point sprites are subject to the
browser/GPU point-size range, so very large sprites and sprites captured by
WebGL live cubemaps may not preserve their apparent world size.

`billboard` defaults to `true`, making sprites face the active camera. Set it to
`false` to render sprite particles as oriented instanced quads instead: WebGL
switches from point sprites to an instanced-quad path, WebGPU stops overriding
particle rotation with the camera quaternion, and the full particle rotation
vector is used.

`sizeAttenuation` controls whether sprite particles shrink with camera distance.
It defaults to `true`. Set it to `false` for graphic, screen-space effects where
particle size should stay visually consistent with distance.

`SpriteMaterialType` is an enum consisting of two string values:

```ts
enum SpriteMaterialType {
  Lit = "lit",
  Unlit = "unlit",
}
```

`material: "unlit"` uses `UnlitSpriteOptions`:

```ts
interface UnlitSpriteOptions {
  gridSize: { x: number; y: number };
  frames: number;
  alphaMap: THREE.Texture;
  softParticles: boolean;
  softParticleDistance: number;
  transmission: number;
  transmissionMap: THREE.Texture;
  distortionMap: THREE.Texture;
  distortionStrength: number;
}
```

`material: "lit"` uses `LitSpriteOptions`, which extends
`THREE.ShaderMaterialParameters`:

```ts
interface LitSpriteOptions extends THREE.ShaderMaterialParameters {
  gridSize: { x: number; y: number };
  frames: number;
  alphaMap: THREE.Texture;
  normalMap: THREE.Texture;
  normalStrength: number;
  normalLighting: number;
  sphericalNormals: number;
  roughness: number;
  roughnessMap: THREE.Texture;
  metalness: number;
  metalnessMap: THREE.Texture;
  envMap: THREE.Texture;
  envIntensity: number;
  softParticles: boolean;
  softParticleDistance: number;
  transmission: number;
  transmissionMap: THREE.Texture;
  distortionMap: THREE.Texture;
  distortionStrength: number;
}
```

Soft particles read scene depth from the active Three.js renderer and fade near
intersections. Set `softParticleDistance` above `0` to enable the effect.
`sphericalNormals` blends generated sphere-like sprite normals from `0` to `1`.
`transmission` blends sprites with the current scene color, optionally masked by
`transmissionMap`. `distortionMap` and `distortionStrength` offset the sampled
scene color for heat haze, refraction, and similar distortion effects.
Material `distortionStrength` is measured in world units on the camera plane,
then converted to screen UVs in the sprite shaders, so the same system should
look similar across display resolutions. A particle's `distortionStrength`
multiplies the material value, so emitters and modules can vary distortion per
particle.

### MeshRenderer

```ts
new MeshRenderer(options?: Partial<MeshRendererOptions>)

interface MeshRendererOptions extends RendererOptions {
  mesh: THREE.Mesh;
  maxParticles: number;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  materialOptions: THREE.MeshStandardMaterialParameters;
  castShadow: boolean;
  receiveShadow: boolean;
}
```

Renders particles as an `InstancedMesh`. Pass a complete `mesh`, or pass
`geometry`, `material`, or `materialOptions`.

### TrailRenderer

```ts
new TrailRenderer(options?: Partial<TrailRendererOptions>)

enum TrailMode {
  Particle = "particle",
  Ribbon = "ribbon",
}

enum TrailTextureMode {
  Stretch = "stretch",
  Tile = "tile",
  RepeatPerSegment = "repeat",
  DistributePerSegment = "distribute",
}

interface TrailRendererOptions extends RendererOptions {
  mode: TrailMode;
  textureMode: TrailTextureMode;
  ratio: number;
  lifetime: DynamicValue<number>;
  minimumVertexDistance: number;
  dieWithParticles: boolean;
  ribbonCount: number;
  width: DynamicValue<number>;
  widthOverTrail: DynamicValue<number>;
  sizeAffectsWidth: boolean;
  sizeAffectsLifetime: boolean;
  inheritParticleColor: boolean;
  colorOverLifetime: DynamicColor;
  colorOverTrail: DynamicColor;
  material: THREE.Material;
  materialOptions: THREE.MeshStandardMaterialParameters;
  castShadow: boolean;
  receiveShadow: boolean;
}
```

Builds per-particle trails or ribbon trails from particle movement.

### LightRenderer

```ts
new LightRenderer(options?: Partial<LightRendererOptions>)

interface PointLightOptions {
  color?: THREE.Color | string | number;
  intensity?: number;
  distance?: number;
  decay?: number;
  power?: number;
}

interface LightRendererOptions extends RendererOptions {
  brightness: DynamicValue<number>;
  rangeMultiplier: DynamicValue<number>;
  groupingRadiusRatio: number;
  decay: number;
  count: number;
  ratio: number;
  randomDistribution: boolean;
  inheritParticleColor: boolean;
  sizeAffectsRange: boolean;
  alphaAffectsIntensity: boolean;
  lightOptions: PointLightOptions;
}
```

Maps particles or particle groups to point lights. Use `count` and `ratio` to
control how many particles can create lights.

## Force Fields

`ParticleForceField` is a `SpatialEffect` that can be placed in the scene. It
applies its own force directly when `ParticleSystem.useSpatialEffects` is true,
so no translator module is required.

```ts
interface ForceFieldOptions {
  position: THREE.Vector3;
  direction: DynamicVector3;
  gravity: DynamicValue<number>;
  rotationSpeed: DynamicValue<number>;
  rotationAttraction: DynamicValue<number>;
  drag: DynamicValue<number>;
  multiplier: DynamicValue<number>;
  radialFalloff: boolean;
  radialFalloffEasing: (falloff: number) => number;
  scale: THREE.Vector3;
  geometry: THREE.BufferGeometry;
  tags: StrictMultiple<Tag>;
  inverted: boolean;
  priority: number | Module.Priority;
  feather: number;
  featherEasing: (feather: number) => number;
}
```

Force fields apply at full strength throughout their spatial range by default.
Set `radialFalloff: true` to multiply the force by a distance-from-origin
falloff based on the field geometry's bounding radius. This preserves the older
"strongest at the center, weakest near the edge" behavior, but it is
intentionally opt-in because it is radial even for non-spherical geometry.

Pass `radialFalloffEasing` to reshape that normalized radial falloff value; when
it is provided, `radialFalloff` defaults to `true`.

`radialFalloff` is different from `feather`. `feather` controls how a spatial
effect blends at its boundary, extending the effect region outward and easing
from full strength to zero. `radialFalloff` changes force magnitude inside the
field based on distance from the field origin. Use `feather`/`featherEasing` for
soft boundaries, and `radialFalloff`/`radialFalloffEasing` only when you
specifically want the force itself to weaken away from the center.

Helpers:

```ts
ParticleForceField.Box(options, ...boxGeometryArgs);
ParticleForceField.Sphere(options, ...sphereGeometryArgs);
ParticleForceField.Cone(options, ...coneGeometryArgs);
ParticleForceField.Torus(options, ...torusGeometryArgs);
```

Set `inverted: true` to apply a field outside its shape instead of inside it.
For example, an inverted spherical attractor can pull particles from outside the
volume toward its center.

Example:

```ts
const attractor = ParticleForceField.Sphere({
  gravity: 10,
  drag: 0.2,
  scale: new THREE.Vector3(4, 4, 4),
  tags: "attractor",
});

scene.add(attractor);
```

Use `ParticleForceFieldHelper` to visualize a field while tuning. It extends the
generic `SpatialEffectHelper` and adds sampled force arrows.

## Spatial Utilities

### ParticleOctree

`ParticleOctree` stores particles in a sparse spatial octree and returns
node-level aggregate data. Nodes also store deduplicated neighboring nodes in
`neighbors`. It is useful when a module needs nearby-particle information
without doing an all-pairs scan each update. In typical neighborhood-query
workloads, that reduces particle interaction work from comparing every particle
to every other particle (`O(n^2)`) to roughly `O(n log n)`. The built-in `Boids`
module uses `ParticleOctree` to aggregate local flocking direction, center of
mass, separation data, and affector influence.

```ts
type OctreeConfig = {
  bounds: THREE.Box3;
  maxDepth: number;
  maxParticlesPerLeaf: number;
  timeQuality?: number;
};

type OctreeAggregator<TAggregate> = {
  "new"(particle?: Particle, particleIndex?: number): TAggregate;
  combine(a: TAggregate, b: TAggregate): TAggregate;
};

const octree = new ParticleOctree(config, aggregator);
const didRebuild = octree.rebuild(particles, tags);

const node = octree.locate(particle.position);
const neighbors = node.neighbors;
```

`aggregator.new()` creates an empty aggregate, while
`aggregator.new(particle, particleIndex)` creates the aggregate contribution for
one particle. `rebuild(particles, tags)` accepts an optional tag or tag list;
omit it or pass an empty list to include every particle. It returns `true` when
the tree was rebuilt and `false` when `timeQuality` skipped this update.

Aggregates should be written as small mutable summaries that can be combined
quickly. For example, a steering module can store a particle count plus summed
positions and velocities, then derive average position or direction in
`combine`. Query a particle's local node with `locate(particle.position)` and
sample that node plus its `neighbors` for nearby information.

`locate(position)` resolves to the theoretical max-depth cell containing the
position when that node exists, or to the smallest existing sparse ancestor
containing that cell. Each node stores neighboring nodes by querying the 26
adjacent positions at that node's depth and resolving each to an existing node
of the same size or larger.

## Collision And Physics

The base package includes `ThreeCollisionBackend`, which raycasts against a
Three.js scene.

```ts
interface ThreeCollisionBackendOptions {
  world?: THREE.Object3D;
  staticObjects?: THREE.Object3D[];
  dynamicObjects?: THREE.Object3D[];

  // How long must an object remain still to be considered static?
  // Defaults to 2 seconds.
  staticAfter?: number;

  // How frequently is the dynamic octree rebuilt?
  // Defaults to 1 => once per update.
  timeQuality?: number;

  // How frequently is the scene scanned for new objects?
  // Defaults to 1 => once per update.
  refreshQuality?: number;

  // Leave null to use Three.js defaults. When GPU collision flattening is
  // active, null defaults become maxLevel: 8 and trianglesPerLeaf: 32.
  maxLevel?: number | null;
  trianglesPerLeaf?: number | null;

  // Whether to prepare GPU-friendly flattened octrees during GPU processing.
  // Defaults to true.
  gpuCollision?: boolean;

  objectFilter?: (object: THREE.Object3D) => boolean;
  staticObjectFilter?: (object: THREE.Object3D) => boolean;
  dynamicObjectFilter?: (object: THREE.Object3D) => boolean;
}
```

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

## Custom Modules

The `Module` class is intentionally small. You can create one directly by
passing a custom particle modify function.

### Constructor Function

```ts
import { Module } from "@rzmps/rzmps";

const upwardDrift = new Module((particle, deltaTime) => {
  particle.velocity.y += 0.5 * deltaTime;
}, {
  priority: -1,
  tags: "smoke",
});

system.addModule(upwardDrift);
```

### Class Extension

For more involved behavior, subclass `Module`. This is useful when a module
needs named options, cached state, dependent modules, setup work, or cleanup.

```ts
import * as THREE from "three";
import { Module, ModuleOptions, ParticleSystem } from "@rzmps/rzmps";

interface GustModuleOptions extends Partial<ModuleOptions> {
  strength?: number;
  direction?: THREE.Vector3;
}

class GustModule extends Module {
  strength: number;
  direction: THREE.Vector3;

  private elapsed = 0;

  constructor(options: GustModuleOptions = {}) {
    super((particle, deltaTime) => {
      const pulse = 0.5 + Math.sin(this.elapsed * 4) * 0.5;

      particle.velocity.addScaledVector(
        this.direction,
        this.strength * pulse * deltaTime,
      );
    }, options);

    this.strength = options.strength ?? 1;
    this.direction = options.direction ?? new THREE.Vector3(1, 0, 0);
  }

  prepare(system: ParticleSystem, deltaTime: number) {
    super.prepare(system, deltaTime);
    this.elapsed += deltaTime;
    this.direction.normalize();
  }

  cleanup() {
    // Release external resources here.
  }
}

system.addModule(
  new GustModule({
    direction: new THREE.Vector3(1, 0.2, 0),
    tags: "smoke",
  }),
);
```

Use `prepare(system, deltaTime)` for once-per-frame setup, `dependents` for
module chains that must run together, and `cleanup()` for external resources.
When a subclass uses `requireSpatialEffects`, its `prepare(...)` override should
call `super.prepare(system, deltaTime)` before reading `this.spatialEffects`.

### Developing With Spatial Effects

Use a plain `SpatialEffect` when the spatial object can apply its own behavior.
Use `requireSpatialEffects` on a module when the spatial object is only
queryable data and the module owns the particle behavior. This keeps domain
logic in the module while still letting artists and scenes place effect volumes
as regular `THREE.Object3D` instances.

```ts
import {
  Module,
  ModuleOptions,
  Particle,
  ParticleSystem,
  SpatialEffect,
  SpatialEffectOptions,
} from "@rzmps/rzmps";

class HeatField extends SpatialEffect {
  temperature = 1;

  constructor(
    options: Partial<SpatialEffectOptions> & { temperature?: number } = {},
  ) {
    super(null, options);
    this.temperature = options.temperature ?? this.temperature;
  }

  sample(particle: Particle, system: ParticleSystem) {
    return this.test(particle, system) ? this.temperature : 0;
  }
}

class HeatModule extends Module {
  constructor(options: Partial<ModuleOptions> = {}) {
    super((particle, deltaTime, system) => {
      if (!system) return;

      this.spatialEffects.forEach((effect) => {
        const heat = (effect as HeatField).sample(particle, system);
        particle.alpha = Math.max(0, particle.alpha - heat * deltaTime);
      });
    }, {
      ...options,
      requireSpatialEffects: HeatField,
    });
  }

  prepare(system: ParticleSystem, deltaTime: number) {
    super.prepare(system, deltaTime);
    // Additional per-frame setup can go here.
  }
}
```

If you pass an explicit `spatialEffects` list to the module, only that list is
used. Otherwise the module discovers matching effects from the particle system's
scene. Add `spatialEffectFilter` when a module should consume only a subset of
matching effects.

## Benchmarks

<!-- RZMPS_BENCHMARKS_START -->

_Generated by `npm run benchmark:update-report`._

**RZMPS browser benchmark**

Run length: 4.0s measured per case after 1.0s warmup
Measured: 2026-10-04T00:31:35.486Z

FPS and frame time are measured in an uncapped browser render loop by default. `1% Low FPS` is derived from p99 frame time, which is steadier than raw single-frame min/max FPS. `Update` is the measured `ParticleSystem.update()` slice inside that frame.

| Environment | Value |
| --- | --- |
| Mode | headless browser |
| Frame Pacing | uncapped |
| Browser | Chrome/154.0.8037.57 |
| Viewport | 1280x720 |
| Device Pixel Ratio | 1.00 |
| OS | Darwin 24.1.0 arm64 |
| CPU | Apple M4 Pro (14 logical cores) |
| Memory | 24.0GB system, 16.0GB browser hint |
| GPU/WebGL | ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version) (Google Inc. (Apple)) |

| Case | Target Particles | Simulated Particles | Particle Cap | Rendered Frames | Avg FPS | 1% Low FPS | Avg Frame | P99 Frame | Max Frame | Avg Update | P95 Update | Max JS Heap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline 10k simulation only | 10,000 | 10,000-10,000 | 10,000 | 2,825 | 706.2 | 570.9 | 1.42ms | 1.60ms | 2.50ms | 1.33ms | 1.50ms | 81.2MB |
| Baseline 50k simulation only | 50,000 | 50,000-50,000 | 50,000 | 338 | 84.4 | 77.5 | 11.85ms | 12.60ms | 13.70ms | 11.72ms | 12.30ms | 188.8MB |
| Typical VFX 5k sprite | 5,000 | 5,000-5,000 | 5,000 | 593 | 148.1 | 70.2 | 6.75ms | 11.60ms | 15.40ms | 6.57ms | 7.80ms | 234.1MB |
| Heavy modules 10k noise+forces | 10,000 | 10,000-10,000 | 10,000 | 720 | 179.8 | 124.2 | 5.56ms | 7.20ms | 10.10ms | 5.43ms | 6.10ms | 251.0MB |
| SpriteRenderer 5k rendered | 5,000 | 5,000-5,000 | 5,000 | 1,847 | 461.8 | 237.2 | 2.17ms | 2.90ms | 11.00ms | 2.05ms | 2.40ms | 323.8MB |
| SpriteRenderer 10k rendered | 10,000 | 10,000-10,000 | 10,000 | 772 | 192.9 | 87.9 | 5.18ms | 10.20ms | 14.40ms | 5.02ms | 7.70ms | 356.2MB |
| SpriteRenderer 50k rendered | 50,000 | 50,000-50,000 | 50,000 | 71 | 17.7 | 17.4 | 56.41ms | 57.40ms | 57.40ms | 56.16ms | 56.90ms | 551.7MB |
| MeshRenderer 10k rendered | 10,000 | 10,000-10,000 | 10,000 | 1,185 | 296.2 | 198.3 | 3.38ms | 4.70ms | 5.50ms | 3.22ms | 3.80ms | 575.9MB |
| TrailRenderer 2k rendered | 2,000 | 2,000-2,000 | 2,000 | 2,368 | 591.8 | 210.2 | 1.69ms | 2.70ms | 9.60ms | 1.54ms | 2.10ms | 974.7MB |

<!-- RZMPS_BENCHMARKS_END -->

## Developer Guide

Clone the repository and install dependencies:

```bash
git clone https://github.com/rzmay/rzmps.git
cd rzmps
npm install
```

Build the core package:

```bash
npm run build --workspace packages/rzmps
```

Run the package in watch mode:

```bash
npm run dev --workspace packages/rzmps
```

Run the demo locally:

```bash
npm start --workspace apps/demo
```

Build the demo:

```bash
npm run build --workspace apps/demo
```

Build the physics extensions:

```bash
npm run build --workspace @rzmps/rapier
npm run build --workspace @rzmps/jolt
npm run build --workspace @rzmps/ammo
```

Build all publishable packages:

```bash
npm run build:modules
```

Run the core library regression tests:

```bash
npm test
```

The test suite lives in `packages/rzmps/tests` and focuses on behavior that is
easy to regress while optimizing internals: force application, priority phases,
depth and size mapping, distortion controls, audio effect calculations,
mutable-value isolation, and subsystem inheritance.

Run the benchmark suite and print browser-rendered results to the terminal:

```bash
npm run benchmark:run
```

Benchmark runs disable browser frame-rate limiting by default. Add `-- --vsync`
to measure refresh-rate-bound behavior instead.

Open a visible browser window while running the same benchmark:

```bash
npm run benchmark:run -- --open
```

Serve the built benchmark page for visual/manual inspection:

```bash
npm run benchmark:serve --workspace demo
```

Then open `http://127.0.0.1:4173/?benchmark=1`.

Update the benchmark report tables in the READMEs:

```bash
npm run benchmark:update-report
```

## License

MIT
