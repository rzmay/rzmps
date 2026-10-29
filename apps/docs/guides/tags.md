# Using Tags

Tags divide one particle population into independently styled or modified groups. An emitter assigns tags when particles are born. A module or renderer with a tag filter accepts particles sharing a selected tag; a component without a tag selection applies to the whole population.

`tagSelection: 'all'` assigns the supplied tags together. Use `'distribute'` to cycle through them, giving separate particles separate tags. A particle carrying both `spheres` and `cubes` would match both renderers; distributed assignment avoids rendering each particle twice in the [Cubes and Spheres example](../examples/tags.md).

That example uses a single emitter at 12 particles per second. Cube particles rotate and fade, while sphere particles grow and collide. Sprite and mesh renderers filter by the same tag names. This keeps emission timing and system ownership shared while changing appearance and behavior.

A `condition` callback further restricts a module or spatial effect after tag matching. Use it for a value-dependent rule, such as age or speed, instead of creating a tag for every transient state. Keep conditions cheap because they run over the candidate population each update.

Tags are application-defined values. Use consistent names across emitters, module filters, renderer filters, and particle-affector `sourceTags`. A misspelled tag can produce a technically valid but invisible effect; inspect both the population and the rendered preview when diagnosing it.

## Changing Tags During Updates

CPU modules can modify `particle.tags` directly. GPU update callbacks can use `particle.addTag(name)` and
`particle.removeTag(name)` to modify the particle's bitmask without assigning bit positions themselves:

```ts
const pulseTags = new Module(() => {}, {
  modifyGPU(particle) {
    If(particle.alpha.greaterThan(0.5), () => {
      particle.addTag('glowing');
    }).Else(() => {
      particle.removeTag('glowing');
    });
  },
});
const lights = new LightRenderer({ tags: 'glowing', count: 16 });
```

Here `If` comes from `three/tsl`; `Module` and `LightRenderer` come from `@rzmps/rzmps`. The tag must already be
registered by an emitter, module, renderer, spatial effect, or subsystem tag selector in the composition. The light
renderer registers `glowing` in this example. Unknown names throw during shader construction, so typos cannot silently
change unrelated bits. Repeated additions and removals are idempotent and preserve other tags, including bit 31.

Use a permanent module priority when the change should persist into later simulation steps. A transient module's
changes follow the existing transient-state rules. GPU event records are snapshots; their source views cannot use
these helpers to mutate a live particle. GPU tag capacity remains 32 names per composition.

The [Fireflies example](../examples/fireflies.md) gives its glow pulses their own particle system, allowing a light
renderer to select that population directly without changing tags.
