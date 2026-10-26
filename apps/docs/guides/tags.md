# Using Tags

Tags divide one particle population into independently styled or modified groups. An emitter assigns tags when particles are born. A module or renderer with a tag filter accepts particles sharing a selected tag; a component without a tag selection applies to the whole population.

`tagSelection: 'all'` assigns the supplied tags together. Use `'distribute'` to cycle through them, giving separate particles separate tags. A particle carrying both `spheres` and `cubes` would match both renderers; distributed assignment avoids rendering each particle twice in the [Cubes and Spheres example](../examples/tags.md).

That example uses a single emitter at 12 particles per second. Cube particles rotate and fade, while sphere particles grow and collide. Sprite and mesh renderers filter by the same tag names. This keeps emission timing and system ownership shared while changing appearance and behavior.

A `condition` callback further restricts a module or spatial effect after tag matching. Use it for a value-dependent rule, such as age or speed, instead of creating a tag for every transient state. Keep conditions cheap because they run over the candidate population each update.

Tags are application-defined values. Use consistent names across emitters, module filters, renderer filters, and particle-affector `sourceTags`. A misspelled tag can produce a technically valid but invisible effect; inspect both the population and the rendered preview when diagnosing it.
