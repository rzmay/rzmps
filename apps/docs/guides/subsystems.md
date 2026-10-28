# Using Subsystems

Attach a secondary ParticleSystem with `parent.addSubSystem(child, options)`. The parent owns its simulation timing; update only the root. The child is reused across emissions, with separate emission contexts for parent particles, rather than creating a new system for every event.

Choose `emitOnSpawn`, `emitOnDeath`, or `emitOnCollision` for event bursts. Use `emitContinuous` for a stream following live parent particles. A burst emitter with `rate: 0` and a time-zero burst is a good starting point for a short event effect. A continuous smoke emitter needs a rate and a lifetime long enough to leave a visible wake.

Inheritance factors control scale, lifetime, color, alpha, mass, and velocity transferred from the triggering particle. Set `inheritLifetime: 0` when a death burst should keep its own lifetime; inheriting a dying particle's lifetime would defeat the separate timing. Set `inheritScale: 0` when the secondary effect should retain a fixed world size. `ratio` samples which parent particles emit; lowering it reduces child population and renderer costs.

Collision emission needs a Collision module and collidable scene geometry or a configured collision backend. `impulseThreshold` rejects weak contacts; impulse factors can increase spark scale or speed, and `impulseAffectsAlignment` points emission away from the contact. Test in a collision scene: an empty scene cannot demonstrate a contact-triggered effect.

[Fireworks](../examples/fireworks.md) combines continuous rocket smoke and a death burst. [Metal Balls](../examples/collisionSubEmitters.md) combines collision sparks and collision audio. Inspect their source-linked system regions as well as their emitter regions: the child's lifetime, gravity, and looping choices are independent of the parent.

Destroy the owning root to clean up the effect. Do not also update owned subsystems from a scene traversal, or attempt to reuse one child under two parents. Explicit frame advancement follows the same parent-owned event processing as normal updates.

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
