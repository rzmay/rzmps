# Emission Sources and Custom Events

A subsystem can follow a simulated particle or a persistent CPU-managed emission source. Registered sources use the
existing emitter contexts, tag intersection, deterministic ratio selection, numeric inheritance and event runs. They do
not enter the particle population, consume simulated slots, or require placeholder particles. Update only the owning
root system; its children share its clock.

## Registering and Updating Sources

```ts
const source = system.registerEmissionSource({
  tags: ['acid-pool'],
  transform: new THREE.Matrix4().makeTranslation(0, 0.1, 0),
  color: new THREE.Color('#78e832'),
  alpha: 1,
  scale: 1,
  velocity: new THREE.Vector3(),
  mass: 1,
});

source.update({ alpha: 0.5 });
source.emitEvent('bubble', { strength: 2 });
// Equivalent system methods:
system.updateSource(source.id, { alpha: 0.5 });
system.emitEvent(source.id, 'bubble', { strength: 2 });
// Use either removal form:
source.dispose();
system.unregisterEmissionSource(source.id);
```

Registration returns a `RegisteredEmissionSource` handle. The package already exports an `EmissionSource` enum for
geometry sampling (`Volume`, `Surface`, `Vertices`); that existing export remains compatible. The handle delegates
update, dispatch and disposal to its owning system and exposes `id`, `system`, canonical attributes, and a copied `data`
snapshot. Input matrices, vectors, colors and tag arrays are copied. Registered IDs start with `source:`; existing
particle IDs retain their format.

Transforms and velocities use the owning system's simulation space. In world simulation supply world transforms; in
local simulation premultiply world transforms by the system's inverse world matrix. The emitter's local +Y axis is the
outward axis for surface emission. Source transform scale and optional scalar `scale` combine for transform inheritance.
Updating attributes preserves identity, registration age, distance credit and burst progression.

A source remains alive until disposed or its owner is destroyed. Registration dispatches `spawn`; removal dispatches
`death` exactly once and immediately stops continuous emission. Repeated disposal is safe. Removal releases continuous
emitter context state; already created child particles and captured event runs finish normally. Ordinary particle
clearing does not remove externally registered sources; explicit removal or system destruction does.

`realtime` is source age in milliseconds of parent simulation time, respecting pause and simulation speed. `time` is
that age divided by the owning system duration. Registered sources have no finite particle lifetime; their child
emitters use their own duration and looping behavior. Set `inheritLifetime: 0` explicitly to communicate that
independent timing. `rateOverDistance` follows source transform movement using the same per-context distance accumulator
as particle-backed emission. Multiple position updates before one frame contribute the final displacement, rather than
every intermediate point.

## Selecting Sources and Inheriting Attributes

```ts
system.addSubSystem(smoke, {
  tags: ['acid-pool'],
  emitContinuous: true,
  ratio: 0.75,
  shouldEmit: source => source.alpha > 0.05,
  inheritLifetime: 0,
  inheritScale: 0.5,
  inheritColor: 1,
  inheritAlpha: 1,
  inheritVelocity: 0.25,
});
```

`tags` uses the same intersection semantics as modules and renderers: omission accepts every source; an empty selection
accepts none. Both particles and registered sources can drive this child simultaneously when their tags match. No
source-type switch is needed. `ratio` chooses sources consistently by identity; `shouldEmit` receives their common
attributes. Function-valued selectors use CPU evaluation; they cannot automatically become a native GPU predicate.
Native GPU particle consumers require boolean `shouldEmit`. Continuous CPU consumers of GPU particles receive
asynchronous snapshots through the existing selective readback infrastructure; their source contexts are released when
those snapshots report removal. Registered sources remain directly available to these selectors without source readback.

Inheritance factors remain numbers. Color, alpha, mass, and transform scale blend from neutral values using their
configured factors; inherited velocity adds the selected fraction of source velocity. Scale inheritance affects the
emission frame, while an event context's scalar `scale` multiplies child particle size. Child particles can themselves
drive nested subsystems, on CPU or GPU. Registered source updates do not restart continuous bursts or event runs.

## One Event API

```ts
system.emitEvent(particle.id, 'explode', { strength: 3 });
particle.emitEvent('explode', { strength: 3 });
source.emitEvent('bubble', { strength: 1.5 });

system.addSubSystem(splash, { onEvent: ['explode', 'bubble'] });
```

`emitEvent` resolves a live particle or registered source in its owning system. Unknown or disposed IDs are ignored. A
CPU particle's alias uses ownership stored outside its serializable attributes; cloning or making a render-only shallow
view does not copy that ownership. Dispatch never performs shader compilation or requires explicit event registration.

CPU dispatch targeting a native GPU particle ID queues a generation-validated selective snapshot at
the next system update. Its CPU handler runs asynchronously when that snapshot is available, then
stages births for GPU children where appropriate. A recycled or dead generation is ignored. Calls
are batched without coalescing separate events, and a busy readback pool retries the batch. This
explicit CPU-to-GPU targeting is separate from GPU-native events, which need no snapshot readback.

An event-only subscription disables continuous emission by default. Set `emitContinuous: true` when both are desired.
`emitOnSpawn`, `emitOnDeath` and `emitOnCollision` remain supported; subscribing to a built-in event through both a
legacy flag and `onEvent` creates one run, with the named callback applied once. Explicit collision events can also
originate from registered sources. Supplying the established collision hit shape preserves impulse threshold, alignment
and scaling behavior.

### CPU Context Handlers

```ts
system.addSubSystem(splash, {
  tags: ['acid-pool'],
  onEvent: {
    bubble: (data, source, context) => {
      if (typeof data !== 'object' || data === null
        || !('strength' in data) || typeof data.strength !== 'number') return;
      return {
        scale: context.scale * data.strength,
        velocity: context.velocity.clone().add(new THREE.Vector3(0, data.strength, 0)),
      };
    },
  },
});
```

CPU handlers execute immediately at dispatch, receive an arbitrary JavaScript payload typed as `unknown`, a common
source view, and the inherited `EmissionContext`, and may return partial overrides. Applications narrow or assert their
own payload schema; the library never needs to know it. Event contexts own their mutable values. Changing an event
context never changes persistent source attributes. A run captures the resolved values, so later source updates or
disposal do not alter that event.

Context overrides include transform, position, color, alpha, mass, velocity, scalar scale, velocityScale,
distortionStrength and duration. Identity and elapsed run timing remain owned by the scheduler. A position-only override
updates transform translation; a transform-only override updates the context position. Supplying both keeps both
explicit values. Collision runs retain existing impulse effects and their snapshot-based lifecycle.

## GPU-Native Events

Inside a module's `modifyGPU(particle, deltaTime, context)`, use `particle.emitEvent(name, payload)` within the relevant
TSL control flow. It appends a snapshot and payload to the existing GPU event buffer at that point in the graph.
Multiple events from one particle remain separate records.

```ts
system.addSubSystem(splash, {
  onEvent: {
    explode: (data, source, context) => {
      if (typeof data !== 'object' || data === null
        || !('strength' in data) || typeof data.strength !== 'number') return;
      return { scale: context.scale * data.strength };
    },
    gpu: {
      explode: (data, particle, context) => ({
        scale: context.scale.mul(data[0].x),
        velocity: context.velocity.add(particle.velocity.mul(data[0].y)),
      }),
    },
  },
});
```

GPU handlers are JavaScript callbacks that **build TSL expressions during kernel compilation**. They are not JavaScript
callbacks executed per particle or per event at runtime. Return TSL nodes for context overrides. GPU context includes
`transform` (a matrix node), `position`, `color`, `alpha`, `mass`, `velocity`, `scale`, `velocityScale`, and `duration`;
transform and position overrides use the same translation precedence as CPU contexts. Full affine transforms are
preserved in persistent GPU event runs.

Names are discovered automatically from both CPU and GPU subscriptions. Built-in IDs remain death = 1, spawn = 2,
collision = 3. Each parent system supports **32 distinct names: three built-ins plus 29 custom names**. IDs are retained
for that system's lifetime, including previously used names after a subscription is removed. Exceeding capacity throws a
diagnostic. Subscription changes can rebuild the affected GPU kernels; data updates and dispatch do not.

An unsubscribed GPU event name produces no record. If both implementations exist, GPU-origin events use the GPU handler
and CPU-origin events use the CPU handler. A GPU-origin event with only a CPU handler is delivered asynchronously
through event readback. Array subscriptions and `true` entries need no handler and can stay GPU-native.

## GPU Payload Format and Capacity

Each GPU event accepts either one `vec4` node or an array with one to three `vec4` nodes:

```ts
particle.emitEvent('explode', vec4(strength, 0, 0, 0));
particle.emitEvent('impact', [vec4(position, 0), vec4(normal, 0), vec4(impulse, 0)]);
```

The maximum is **three vec4 values, or twelve float components per record**. A fourth vector produces a development-time
error during graph construction. Missing vectors are explicitly initialized to zero, including built-in events that do
not use payloads. Every GPU handler receives exactly three entries, accessible as `data[0]`, `data[1]`, and `data[2]`.
Each supports `.x`, `.y`, `.z`, `.w` and vector swizzles such as `.xyz`.

Payloads contain numerical TSL values. Arbitrary JavaScript objects cannot be sent through a native GPU event. The
particle snapshot is stored separately and remains available to the handler even after the original particle dies or its
slot is reused. Identity validation retains the original slot generation; readback never substitutes the particle
currently occupying that slot.

The event record remains **15 vec4 slots**. Its existing collision point, normal and impulse slots are generalized as
Payload0, Payload1 and Payload2. For collisions, their `.xyz` retain point, normal and impulse, with `.w = 0`. The
separate per-particle collision cache and existing collision APIs remain intact. No additional event buffer or storage
binding is needed for custom payloads.

### Example A: One Scalar

```ts
// Inside modifyGPU:
particle.emitEvent('explode', vec4(strength, 0, 0, 0));
// Inside onEvent.gpu:
const explode = (data, particle, context) => ({
  scale: context.scale.mul(data[0].x),
});
```

Here `data[0].x` carries strength; `data[1]` and `data[2]` are zero vectors.

### Example B: Multiple Parameters

```ts
particle.emitEvent('explode', vec4(strength, radius, temperature, 0));
const explode = (data, particle, context) => ({
  scale: context.scale.mul(data[0].x),
  position: context.position.add(vec3(0, data[0].y, 0)),
  alpha: context.alpha.mul(data[0].z.div(200).clamp(0, 1)),
});
```

This application chooses `.x` for strength, `.y` for radius, `.z` for temperature and leaves `.w` unused. These semantic
meanings are conventions chosen by the developer; RZMPS does not assign them.

### Example C: All Three Vectors

```ts
particle.emitEvent('impact', [
  vec4(position, 0),
  vec4(normal, 0),
  vec4(impulse, 0),
]);
const impact = (data, particle, context) => ({
  position: data[0].xyz,
  velocity: context.velocity.add(data[1].xyz.mul(data[2].xyz.length())),
  scale: context.scale.mul(data[2].xyz.length().max(0.1)),
});
```

This custom impact convention uses position, normal and impulse, reading every vector. It is independent of the built-in
collision event. [Fireflies](../examples/fireflies.md) uses a smaller payload for a neighbor-driven light pulse;
applications only need to fill the components their child effect consumes.

### Readback Representation

GPU events delivered to CPU custom handlers carry `readonly [THREE.Vector4, THREE.Vector4, THREE.Vector4]`. The array
contains decoded numerical values from the event snapshot, not an invented object schema. For example, use `data[0].x`
on CPU too. CPU-generated events may instead carry arbitrary JavaScript data, such as `{ strength: 2 }`. These payload
representations are intentionally different. A CPU callback serving both origins should discriminate the payload shape.

Built-in collision listeners retain their established `CollisionHit` interface. Custom named GPU callbacks receive the
numerical three-vector payload. GPU-to-CPU delivery is asynchronous and preserves frame delivery order as provided by
the existing event pipeline. It may arrive after the originating particle dies; the captured snapshot remains valid for
that run.

## Synchronization and Performance

Registered sources are CPU-managed. Calls to `source.update()` only change canonical CPU attributes; repeated calls
coalesce automatically. At the next system update, existing emitter contexts evaluate continuous and event-run births,
then GPU children receive a single reusable batch. GPU allocation chooses actual free destination slots. No per-source
compute dispatch, source readback or shader recompilation occurs. Applications do not need to throttle updates manually.
This implementation evaluates registered-source emitter scheduling on CPU even when child particle simulation runs on
GPU.

Event dispatches are never coalesced with attribute updates. Every dispatch captures its own context. Persistent event
runs and continuous distance/rate credits retain their separate identities and are released at completion or source
removal. GPU upload storage grows geometrically and is reused across frames.

GPU-generated events consumed entirely by native GPU subsystems use the existing GPU event stream without event-buffer
CPU readback. CPU listeners, CPU-only predicates or CPU event handlers can require asynchronous delivery. Ordinary
particle and allocation diagnostics have their own independent readback behavior.

Three separate limits matter: distinct event names (32), floats per payload (12), and records in the shared event buffer
per frame (`ParticleSystem.GPU_EVENT_BUFFER_CAPACITY`). Custom events share capacity with spawn, death and collision
records. Overflow bounds-checks writes, discards excess records and increments the existing overflow diagnostic.
Concurrent persistent runs also have a finite destination capacity; size child `maxParticles` and event capacity for the
intended overlap. CPU-staged births obey child particle capacity and available GPU slots. Very dense events can be
dropped safely when those destinations are full.

## Persistent Decals

```ts
const decals = new DecalRenderer(material, {
  onSpawn: false,
  onCollision: true,
  emissionTags: ['acid-pool'],
  lifetime: 18,
});
// Attach decals as a renderer of system before emitting particles.
system.addRenderer(decals);
system.addSubSystem(smoke, { tags: ['acid-pool'], emitContinuous: true, inheritLifetime: 0 });
system.addSubSystem(splash, { tags: ['acid-pool'], onEvent: ['bubble'], inheritLifetime: 0 });
for (const decal of decals.decals) {
  decal.source?.emitEvent('bubble', { strength: 0.5 + Math.random() });
}
```

Only decals with `emissionTags` register sources. `decal.source` exposes the persistent handle; its transform uses the
actual decal footprint and points +Y along the outward surface normal. Color and alpha follow the decal material. Moving
rigid surfaces update emission frames automatically. Expiry, eviction, clear/reset and renderer destruction dispose
handles and dispatch death before releasing contexts. Already emitted children remain alive. See [Surface
Decals](./decals.md) and the complete [Acid](../examples/acid.md) factory for independent randomized bubbling and
fading smoke.
