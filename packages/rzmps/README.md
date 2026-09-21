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
- [Built-In Modules](#built-in-modules)
- [Built-In Renderers](#built-in-renderers)
- [Force Fields](#force-fields)
- [Collision And Physics](#collision-and-physics)
- [Custom Modules](#custom-modules)
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
  simulationSpeed: number;
  duration: number;
  prewarm: boolean;
  prewarmFPS: number;
  looping: boolean;
  endBehavior: EndBehavior;
  maxParticles: number;
  maxCullingMode: MaxCulling;
  simulationDistance: number;
  gravity: THREE.Vector3;
  gravityModifier: DynamicValue<number>;
  simulationSpace: SimulationSpace;
  useLiveCubemap: boolean;
  liveCubemapFPS: number;
  liveCubemapResolutionScale: number;
  liveCubemapIntensity: number;
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

Set `useLiveCubemap: true` to render a live environment map from the particle
system and feed it to sprite renderers using `material: "basic"`, mesh
renderers, and trail renderers. `liveCubemapFPS`,
`liveCubemapResolutionScale`, and `liveCubemapIntensity` control the update
rate, resolution cost, and reflection intensity.

`LiveCubemap` is also exported for utility use outside `ParticleSystem`. It is
primarily an internal helper, but can be attached to any `THREE.Object3D` with
`setup(parent)` and updated with `update(scene, renderer, deltaTime)` when you
need a local realtime cubemap. Set `excludeParent: true` to hide the parent
object while the cubemap is rendered, which is useful for reflective objects
that should not capture themselves.

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
  inheritScale: boolean;
  inheritLifetime: boolean;
  inheritColor: boolean;
  inheritAlpha: boolean;
  inheritMass: boolean;
  impulseAffectsScale: number;
  impulseAffectsSpeed: number;
  impulseAffectsLifetime: number;
  impulseAffectsMass: number;
  impulseAffectsAlignment: boolean;
  impulseThreshhold: number;
}
```

```ts
rocketSystem.addSubSystem(sparkSystem, {
  emitOnDeath: true,
  emitContinuous: false,
  inheritColor: true,
  inheritAlpha: true,
  inheritScale: true,
  impulseAffectsScale: 0.35,
  impulseAffectsAlignment: true,
  impulseThreshhold: 0.2,
});
```

Subsystems are owned and updated by their parent. They can emit continuously
from parent particles, or trigger emission runs on spawn, collision, or death.
For collision-triggered emission runs, impulse effect values use
`Math.pow(collision.impulse.length(), effect)`. Scale, speed, and mass use that
result as a multiplier. Lifetime adds that result to the emission run duration.
Alignment rotates the emission so its up axis follows the collision impulse.
`impulseThreshhold` defaults to `0`; collision-triggered runs only start when
`collision.impulse.length() > impulseThreshhold`.

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
  radialSpeed: DynamicValue<number>;
  alignment: DynamicValue<number>;
  tags: StrictMultiple<Tag>;
  tagSelection: TagSelectionMethod;
}
```

Emitter `rate` curves and burst `time` values are evaluated against the owning
particle system's normalized timeline.

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

Most initial values can be dynamic.

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
EmissionShape.Sphere(...sphereGeometryArgs);
EmissionShape.Cone(...coneGeometryArgs);
EmissionShape.Torus(...torusGeometryArgs);
```

## Built-In Modules

All built-in modules extend `Module`. Constructor option objects are partials,
so you only need to pass the fields you want to customize.

```ts
interface ModuleOptions {
  priority: number;
  tags: StrictMultiple<Tag>;
}
```

| Option     | Description                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `priority` | Modules with priority below `0` run before movement. Modules with priority `0` or higher run after movement, sorted by priority. |
| `tags`     | Restricts the module to particles with matching tags.                                                                            |

### VelocityOverLifetime

```ts
new VelocityOverLifetime(options?: Partial<VelocityOverLifetimeOptions>)

interface VelocityOverLifetimeOptions extends Partial<ModuleOptions> {
  linear: DynamicValue<THREE.Vector3>;
  orbital: DynamicValue<THREE.Vector3>;
  orbitOffset: DynamicValue<THREE.Vector3>;
  radial: DynamicValue<number>;
  speedModifier: DynamicValue<number>;
}
```

Sets particle velocity from the start velocity plus optional linear, orbital,
and radial terms. `speedModifier` scales particle simulation speed.

### ForceOverLifetime

```ts
new ForceOverLifetime(options: ForceOverLifetimeOptions)

interface ForceOverLifetimeOptions extends Partial<ModuleOptions> {
  force: DynamicValue<THREE.Vector3>;
}
```

Adds a dynamic force to particle acceleration.

### LimitVelocityOverLifetime

```ts
new LimitVelocityOverLifetime(options: LimitVelocityOverLifetimeOptions)

interface LimitVelocityOverLifetimeOptions extends Partial<ModuleOptions> {
  limit: DynamicValue<THREE.Vector3>;
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

### ColorOverLifetime

```ts
new ColorOverLifetime(options?: ColorOverLifetimeOptions)

interface ColorOverLifetimeOptions extends Partial<ModuleOptions> {
  color?: DynamicValue<THREE.Color>;
  alpha?: DynamicValue<number>;
}
```

Multiplies each particle's start color and alpha over lifetime.

### ColorBySpeed

```ts
new ColorBySpeed(options: ColorBySpeedOptions)

type SpeedRange = [number, number] | { min: number; max: number };

interface ColorBySpeedOptions extends Partial<ModuleOptions> {
  color?: DynamicValue<THREE.Color>;
  alpha?: DynamicValue<number>;
  speedRange?: SpeedRange;
}
```

Multiplies start color and alpha based on normalized speed within `speedRange`.

### ScaleOverLifetime

```ts
new ScaleOverLifetime(options: ScaleOverLifetimeOptions)

interface ScaleOverLifetimeOptions extends Partial<ModuleOptions> {
  scale: DynamicValue<THREE.Vector3>;
}
```

Multiplies each particle's start scale over lifetime.

### ScaleBySpeed

```ts
new ScaleBySpeed(options: ScaleBySpeedOptions)

interface ScaleBySpeedOptions extends Partial<ModuleOptions> {
  scale: DynamicValue<THREE.Vector3>;
  speedRange?: SpeedRange;
}
```

Multiplies start scale based on normalized speed within `speedRange`.

### RotationOverLifetime

```ts
new RotationOverLifetime(options: RotationOverLifetimeOptions)

interface RotationOverLifetimeOptions extends Partial<ModuleOptions> {
  angularVelocity: DynamicValue<THREE.Vector3>;
}
```

Adjusts angular velocity over lifetime.

### RotationBySpeed

```ts
new RotationBySpeed(options: RotationBySpeedOptions)

interface RotationBySpeedOptions extends Partial<ModuleOptions> {
  angularVelocity: DynamicValue<THREE.Vector3>;
  speedRange?: SpeedRange;
}
```

Adjusts angular velocity based on normalized speed within `speedRange`.

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
  strength: DynamicValue<THREE.Vector3>;
  scrollSpeed: DynamicValue<number>;
  damping: boolean;
}
```

Pushes particles through animated 3D noise. Internally, it creates dependent
`NoiseModule` instances for the X, Y, and Z axes.

### ExternalForces

```ts
new ExternalForces(options: ExternalForcesOptions)

interface ExternalForcesOptions extends Partial<ModuleOptions> {
  multiplier?: DynamicValue<number>;
  forceFieldFilter?: (forceField: ParticleForceField) => boolean;
  forceFields?: IParticleForceField[];
}
```

Samples `ParticleForceField` objects and applies their forces to particles. If
`forceFields` is omitted, fields are discovered from the particle system's
scene.

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

### Audio

```ts
new Audio(options?: Partial<AudioOptions>)

interface AudioOptions extends Partial<ModuleOptions> {
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
  alphaAffectsPitch: number;
  alphaAffectsVolume: number;
  speedAffectsPitch: number;
  speedAffectsVolume: number;
  impulseAffectsPitch: number;
  impulseAffectsVolume: number;
  impulseAffectsHighPass: number;
  impulseAffectsLowPass: number;
  impulseThreshhold: number;
}
```

Adds positional audio to particles and can play event sounds for spawn,
collision, and death. `maxClips` defaults to `100` and limits the number of
simultaneous event clips from this module. Collision event sounds can use
`impulseAffectsPitch` and
`impulseAffectsVolume`; each uses `Math.pow(collision.impulse.length(), effect)`
as a multiplier on the evaluated pitch or volume. `highPass` and `lowPass`
create Web Audio `BiquadFilterNode` filters through Three.js.
`impulseAffectsLowPass` raises the low-pass cutoff as impulse increases, while
`impulseAffectsHighPass` lowers the high-pass cutoff as impulse increases, so
gentler collisions can sound more filtered and harder impacts can sound fuller.
Filters are only applied when both the cutoff value and the corresponding
`impulseAffects...` value are greater than `0`.
`impulseThreshhold` defaults to `0`; collision sounds only play when
`collision.impulse.length() > impulseThreshhold`.

## Built-In Renderers

All renderers accept shared renderer options:

```ts
interface RendererOptions {
  tags: StrictMultiple<Tag>;
}
```

### SpriteRenderer

```ts
new SpriteRenderer(
  texture?: string | THREE.Texture,
  options?: Partial<SpriteRendererOptions>
)

interface SpriteRendererOptions extends RendererOptions {
  fps: DynamicValue<number>;
  tileSize: { x: number; y: number };
  tileMargin: { x: number; y: number };
  gridSize: { x: number; y: number };
  frames: number;
  randomStartFrame: boolean;
  alphaMap: string | THREE.Texture;
  material: SpriteMaterialType;
  materialOptions: BasicSpriteOptions | UnlitSpriteOptions;
  castShadow: boolean;
  softParticleDistance: number;
}
```

`SpriteRenderer` renders particles as GPU points in WebGL and camera-facing
instanced quads in WebGPU. It supports sprite sheets, alpha maps, random start
frames, shadows, and soft particles. WebGL point sprites are subject to the
browser/GPU point-size range, so very large sprites and sprites captured by
WebGL live cubemaps may not preserve their apparent world size.

`SpriteMaterialType` is an enum consisting of two string values:

```ts
enum SpriteMaterialType {
  Basic = "basic",
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
}
```

`material: "basic"` uses `BasicSpriteOptions`, which extends
`THREE.ShaderMaterialParameters`:

```ts
interface BasicSpriteOptions extends THREE.ShaderMaterialParameters {
  gridSize: { x: number; y: number };
  frames: number;
  alphaMap: THREE.Texture;
  normalMap: THREE.Texture;
  normalStrength: number;
  normalLighting: number;
  sphericalNormals: boolean;
  roughness: number;
  roughnessMap: THREE.Texture;
  metalness: number;
  metalnessMap: THREE.Texture;
  envMap: THREE.Texture;
  envIntensity: number;
  softParticles: boolean;
  softParticleDistance: number;
}
```

Soft particles read scene depth from the active Three.js renderer and fade near
intersections. Set `softParticleDistance` above `0` to enable the effect.

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
  colorOverLifetime: DynamicValue<THREE.Color>;
  colorOverTrail: DynamicValue<THREE.Color>;
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

`ParticleForceField` is a `THREE.Object3D` that can be placed in the scene and
sampled by `ExternalForces`.

```ts
interface ForceFieldOptions {
  position: THREE.Vector3;
  direction: DynamicValue<THREE.Vector3>;
  gravity: DynamicValue<number>;
  rotationSpeed: DynamicValue<number>;
  rotationAttraction: DynamicValue<number>;
  drag: DynamicValue<number>;
  scale: THREE.Vector3;
  geometry: THREE.BufferGeometry;
  tags: StrictMultiple<Tag>;
}
```

Helpers:

```ts
ParticleForceField.Box(options?, ...boxGeometryArgs)
ParticleForceField.Sphere(options?, ...sphereGeometryArgs)
ParticleForceField.Cone(options?, ...coneGeometryArgs)
ParticleForceField.Torus(options?, ...torusGeometryArgs)
```

Example:

```ts
const attractor = ParticleForceField.Sphere({
  gravity: 10,
  drag: 0.2,
  scale: new THREE.Vector3(4, 4, 4),
  tags: "attractor",
});

scene.add(attractor);

system.addModule(
  new ExternalForces({
    forceFieldFilter: (field) => field.tags?.includes("attractor") ?? false,
  }),
);
```

Use `ParticleForceFieldHelper` to visualize a field while tuning.

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
npm start --workspace packages/demo
```

Build the demo:

```bash
npm run build --workspace packages/demo
```

Build the physics extensions:

```bash
npm run build --workspace @rzmps/rapier
npm run build --workspace @rzmps/jolt
npm run build --workspace @rzmps/ammo
```

## License

MIT
