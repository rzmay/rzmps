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
