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
cannot be translated automatically to a GPU predicate; inspect `getGPUEmissionSupport()` when a
custom subsystem selector is involved.

Registered sources and named custom events also drive these same subsystem contexts. Use `tags`
to select eligible source tags and `onEvent` for CPU or native GPU context handlers. See
[Emission Sources and Custom Events](./emission-sources-events.md) and
[Acid](../examples/acid.md).

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
