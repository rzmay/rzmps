# Using Subsystems

Attach a secondary ParticleSystem with `parent.addSubSystem(child, options)`. The parent owns its simulation timing;
update only the root. The child is reused across emissions, with separate emission contexts for parent particles, rather
than creating a new system for every event.

Choose `emitOnSpawn`, `emitOnDeath`, or `emitOnCollision` for event bursts. Use `emitContinuous` for a stream following
live parent particles. A burst emitter with `rate: 0` and a time-zero burst is a good starting point for a short event
effect. A continuous smoke emitter needs a rate and a lifetime long enough to leave a visible wake.

Inheritance factors control scale, lifetime, color, alpha, mass, and velocity transferred from the triggering particle.
Set `inheritLifetime: 0` when a death burst should keep its own lifetime; inheriting a dying particle's lifetime would
defeat the separate timing. Set `inheritScale: 0` when the secondary effect should retain a fixed world size. `ratio`
samples which parent particles emit; lowering it reduces child population and renderer costs.

## A death-triggered burst

Set `impulseAffectsCount` to scale every emitter in a collision run by
`impulseMagnitude ** impulseAffectsCount`. The default `0` leaves emission unchanged; `1` is linear
and `0.5` uses a square root. This multiplier applies to burst counts, rate and rate over distance,
and combines with population LOD before integer counts are allocated. Fractional emission credit
is retained within the emission context. Spawn/death events and continuous parent-following emission
keep their configured counts. The multiplier uses the triggering impact for the whole emission run.
[Destruction](../examples/destruction.md) uses square-root scaling to shed fewer fragments on weak impacts.
Both CPU and native GPU processing support this without additional storage buffers.

[Fireworks](../examples/fireworks.md) combines continuous rocket smoke and a death burst. [Metal Balls](../examples/collisionSubEmitters.md) combines collision sparks and collision audio. Inspect their source-linked system regions as well as their emitter regions: the child's lifetime, gravity, and looping choices are independent of the parent.

This child emits once for each parent death. Only the root needs an update call:

```ts
import * as THREE from 'three';
import { Emitter, ParticleSystem, SpriteRenderer, Textures } from '@rzmps/rzmps';

const sparks = new ParticleSystem({
  duration: 0.3,
  emitters: new Emitter({
    rate: 0,
    bursts: { time: 0, count: 12 },
    radialSpeed: 2,
    initialValues: { lifetime: 0.4, scale: 0.06 },
  }),
  renderers: new SpriteRenderer(Textures.Simple),
});

parent.addSubSystem(sparks, {
  emitOnDeath: true,
  inheritLifetime: 0,
  inheritScale: 0,
  inheritVelocity: 0.25,
});

// In the scene's animation loop:
parent.update();
```

Subsystem emitters subscribe to their immediate parent's events by default. Their own particles dying do not
restart the effect. Use an explicit `eventScope` when another origin is intended. Child particles receive their
emitter's own tags; they do not automatically inherit source tags.

Collision emission needs a Collision module and collidable scene geometry or a configured collision backend.
`impulseThreshold` rejects weak contacts; impulse factors can increase spark scale or speed, and
`impulseAffectsAlignment` points emission away from the contact. Test in a collision scene: an empty scene cannot
demonstrate a contact-triggered effect.

[Fireworks](../examples/fireworks.md) combines continuous rocket smoke and a death burst. [Metal
Balls](../examples/collisionSubEmitters.md) combines collision sparks and collision audio. Inspect their source-linked
system regions as well as their emitter regions: the child's lifetime, gravity, and looping choices are independent of
the parent.

Destroy the owning root to clean up the effect. Do not also update owned subsystems from a scene traversal, or attempt
to reuse one child under two parents. Explicit frame advancement follows the same parent-owned event processing as
normal updates.

GPU-active roots schedule subsystem systems parent-before-child and keep native spawn, death,
collision, and continuous runs in GPU buffers. CPU listeners and CPU-input renderers receive
asynchronous event/readback data and can observe a small delay. A function-valued `shouldEmit`
cannot be translated automatically. Supply its TSL counterpart with `shouldEmitGPU`:

```ts
parent.addSubSystem(child, {
  shouldEmit: particle => particle.velocity.length() > 2,
  shouldEmitGPU: particle => particle.velocity.length().greaterThan(2),
  emitContinuous: true,
  inheritVelocity: 1,
  inheritLifetime: 0,
});
```

`shouldEmitGPU(particle, deltaTime, context)` runs in a separate GPU eligibility pass.
`deltaTime` is the parent simulation step in seconds. `context.system` is the source parent,
`context.childSystem` is the child, and `context.eventType` identifies event-driven requests
(undefined for continuous emission). Event predicates inspect the captured particle state,
not a live slot that may have been recycled. A boolean `shouldEmit: false` disables emission
even with a GPU predicate. CPU simulation uses `shouldEmit`; it does not execute TSL callbacks.

A predicate can attach `spatialGridOptions` to request a current parent query grid:

```ts
import { float, If, uint } from 'three/tsl';
import type { SubSystemGPUCondition } from '@rzmps/rzmps';

const isolated: SubSystemGPUCondition = (particle, _deltaTime, { spatialGrid }) => {
  if (!spatialGrid) throw new Error('This predicate requires its configured spatial grid.');
  const count = uint(0).toVar();
  spatialGrid.forEachParticleInRadius(particle.position, float(0.5), neighbor => {
    If(neighbor.index.notEqual(particle.index).or(neighbor.generation.notEqual(particle.generation)), () => {
      count.addAssign(1);
    });
  });
  return count.lessThan(3);
};
isolated.spatialGridOptions = { brickSubdivisions: 3, cellSubdivisions: 1, maxQuerySteps: 0 };
```

Query neighborhoods contain current live parent particles, including when the predicate tests
an older event snapshot. The optional grid is refreshed after parent integration/collision;
it is not a historical event neighborhood. Eligibility output is shared across child emitters.
Replacing a callback invalidates its GPU pipeline by function identity; changing captured
JavaScript constants requires a new callback (or use TSL uniforms).
Inspect `getGPUEmissionSupport()` when using custom selectors. See the
[experimental liquid notes](https://github.com/rzmay/rzmps/blob/develop/examples/experimental/liquid-quality-and-whitewater.md)
for the opt-in spray-selection factory; it does not create or render a secondary effect by itself.
Registered sources and named custom events also drive these same subsystem contexts. Use `tags`
to select eligible source tags and `onEvent` for CPU or native GPU context handlers. See
[Emission Sources and Custom Events](./emission-sources-events.md) and
[Acid](../examples/acid.md).

## Event callbacks and emission context

Use `onEvent: ['flash']` to emit with the prepared context, or supply a callback to customize it. Callbacks can live
on the child emitter or in `addSubSystem()` options. Attachment options override the emitter configuration for that
relationship; an attachment's `onEvent` replaces the emitter's subscription map.

A CPU callback receives `(data, source, context)`. `data` is application-defined and typed as `unknown`; narrow it
before reading it. `source` is the triggering particle or registered source. `context` already contains the resolved
source transform and configured inheritance, expressed in the child's simulation space.

```ts
const flashEmitter = new Emitter({
  rate: 0,
  bursts: { time: 0, count: 6 },
  radialSpeed: 0.2,
  initialValues: { lifetime: 0.5, scale: 0.12 },
  inheritLifetime: 0,
  onEvent: {
    flash: (data, _source, context) => {
      // This event uses a number as its payload; other payloads fall back to normal strength.
      const strength = typeof data === 'number' ? THREE.MathUtils.clamp(data, 0.1, 3) : 1;
      return {
        scale: strength,
        alpha: context.alpha * Math.min(strength, 1),
        velocity: context.velocity.clone().add(new THREE.Vector3(0, strength, 0)),
        duration: 0.25,
      };
    },
  },
});
const flashes = new ParticleSystem({
  emitters: flashEmitter,
  renderers: new SpriteRenderer(Textures.Simple),
});
parent.addSubSystem(flashes);

// A live parent particle or a registered source can trigger the same callback.
particle.emitEvent('flash', 2);
source.emitEvent('flash', 0.5);
// With no source ID, emission uses the producing system's origin.
parent.emitEvent('flash', 1);
```

The callback runs once per accepted event, not once per emitted particle. Its returned values are captured for that
emission run, including delayed births. Returning a partial context replaces only those fields; returning nothing
keeps the prepared values and still emits.

Context `scale`, `color`, `alpha`, and `mass` multiply the child's initial values. `velocity` adds a velocity vector;
`velocityScale` multiplies its initial velocity contribution. Context `duration` controls the emission run, while
`initialValues.lifetime` controls how long each child particle lives. The example's `scale: 2` therefore doubles
its configured `0.12` particle size without changing that emitter for other events.

Clone vectors or colors when deriving overrides from the context. For example, a built-in death event can emit
slightly above its final origin:

```ts
parent.addSubSystem(sparks, {
  inheritLifetime: 0,
  inheritScale: 0,
  onEvent: {
    death: (_data, _source, context) => ({
      position: context.position.clone().add(new THREE.Vector3(0, 0.5, 0)),
    }),
  },
});
```

This supplies a named callback for the first example's death event. Returning only `position` also updates the
emission transform's translation; returning only `transform` derives the position from that matrix. A custom
transform should also be authored in the child's simulation space.

### Native GPU callbacks

For native GPU event emission, provide the corresponding TSL handler under `onEvent.gpu`. Configure both callbacks
before starting the system when the effect should support CPU and GPU processing:

```ts
import { float, vec3, vec4 } from 'three/tsl';

flashEmitter.onEvent = {
  flash: (data, _source, context) => {
    const strength = typeof data === 'number' ? THREE.MathUtils.clamp(data, 0.1, 3) : 1;
    return {
      scale: strength,
      alpha: context.alpha * Math.min(strength, 1),
      velocity: context.velocity.clone().add(new THREE.Vector3(0, strength, 0)),
      duration: 0.25,
    };
  },
  gpu: {
    flash: ([payload], _particle, context) => {
      const strength = payload.x.clamp(0.1, 3);
      return {
        scale: strength,
        alpha: context.alpha.mul(strength.min(1)),
        velocity: context.velocity.add(vec3(0, strength, 0)),
        duration: float(0.25),
      };
    },
  },
};

// Inside a GPU module's modifyGPU callback:
particle.emitEvent('flash', vec4(2, 0, 0, 0));
```

GPU handlers receive shader nodes and up to three `vec4` payload values. Build calculations with TSL operations;
ordinary JavaScript conditionals cannot branch on a shader value. Native handlers operate on GPU event storage
without CPU event readback. A CPU callback alone does not become GPU code automatically. See
[Emission Sources and Custom Events](./emission-sources-events.md) for payload and subscription details.

## Simulation frames

`simulationSpace` selects the reference frame for particle motion:

| Mode | Frame |
| --- | --- |
| `'world'` | Identity world matrix. Existing particles stay behind when the system moves. |
| `'local'` | The particle system's world transform. |
| `'transform'` | `simulationSpaceTransform`, supplied as an Object3D or world Matrix4; omitted means identity. |
| `'source'` | Each particle's emitting source transform. On a root system, this behaves like Local. |

Transform mode keeps a live reference. Moving the supplied Object3D, including its ancestors, or editing the supplied
world Matrix4 moves existing particles with that frame. The emitter still belongs to the particle system: its world
pose is converted into the selected simulation frame at birth. A source is a per-particle version of this relationship,
so one shared subsystem can attach particles to many moving sources.

```js
const pulses = new ParticleSystem({
  simulationSpace: 'source',
  sourceLoss: 'kill',
  // emitters, modules, renderers...
});
fireflies.addSubSystem(pulses, {
  onEvent: ['flash'],
  inheritLifetime: 0,
  inheritScale: 0,
});
```

Source particles keep their sampled offsets and independent motion while following source translation, rotation, and
inherited scale. `inheritScale: 0` keeps the attachment frame's scale at one. This avoids a follow module, source maps,
or storing source identity in application-owned particle attributes. Both registered sources and simulated particles
work; native GPU sources use slot and generation handles without copying their transforms through the CPU.

`sourceLoss` defaults to `'detach'`: an existing particle stops following the lost source and continues from its last
resolved pose. Choose `'kill'` for effects that should disappear with their source, such as firefly pulses. Reusing a
GPU
slot never reattaches an old particle to its replacement. Delayed births from a lost source are canceled; a death event
instead emits from its final snapshot and creates unattached particles. Singular reference matrices retain the last
usable frame for existing attachments. Use nonzero scales for emission.

Source space permits motion relative to the source. To pin a particle to its sampled offset, set the emitter's
`radialSpeed: 0` and leave its initial velocity and inherited velocity at zero; movement modules can also move it away
from that offset. The emitter's default radial speed is 1, including in Source space.

An explicitly configured child space survives parenting and parent space changes. A child with no explicit space
inherits its parent's mode, including its Transform reference when no child reference is supplied. For example, a
World parent gives an unspecified child World space, while an explicitly configured Source child stays in Source space.
Assigning `child.simulationSpace` also makes that child's choice explicit. This replaces the previous forced matching
of parent and child modes; emission converts between their frames when they differ. Changing the mode
or replacing `simulationSpaceTransform` preserves the world pose of existing particles; moving the referenced transform
moves the effect. GPU conversion takes place at the next simulation step.

Modules, particle positions, spatial queries, collisions, renderer inputs, and readback use a shared resolved coordinate
space: World uses world coordinates, Transform uses the supplied frame, and Local/Source use the system's coordinates.
Source offsets and motion are transformed into that common space before module updates. Consequently neighbor queries
can compare particles emitted by different sources, and scene forces act in the common frame. Use
`simulationToWorld`, `worldToSimulation`, and `getSimulationToWorldMatrix` for application conversions;
`resolveSimulationFrame(particle)` also includes a CPU particle's attachment frame. Three.js `localToWorld` and
`worldToLocal` continue to describe the Object3D itself. Particle orientation and scale use TRS decomposition;
compositions that introduce shear have the same approximation as Three.js Object3D transforms.

See [Fireflies](../examples/fireflies.md) for native Source attachments and
[Emission Sources and Custom Events](./emission-sources-events.md) for registered origins and payload handlers.
