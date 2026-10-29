# Using Tags

Tags divide one particle population into independently styled or modified groups. An emitter assigns tags when particles are born. A module or renderer with a tag filter accepts particles sharing a selected tag; a component without a tag selection applies to the whole population.

`tagSelection: 'all'` assigns the supplied tags together. Use `'distribute'` to cycle through them, giving separate particles separate tags. A particle carrying both `spheres` and `cubes` would match both renderers; distributed assignment avoids rendering each particle twice in the [Cubes and Spheres example](../examples/tags.md).

That example uses a single emitter at 12 particles per second. Cube particles rotate and fade, while sphere particles grow and collide. Sprite and mesh renderers filter by the same tag names. This keeps emission timing and system ownership shared while changing appearance and behavior.

A `condition` callback further restricts a module or spatial effect after tag matching. Use it for a value-dependent rule, such as age or speed, instead of creating a tag for every transient state. Keep conditions cheap because they run over the candidate population each update.

Tags are application-defined values. Use consistent names across emitters, module filters, renderer filters, and particle-affector `sourceTags`. A misspelled tag can produce a technically valid but invisible effect; inspect both the population and the rendered preview when diagnosing it.


## Choosing textures and meshes by tag

SpriteRenderer textures and MeshRenderer `mesh` / `geometry` options accept a resource, an array,
or a nested tag map. All resources are discovered during construction and use the same atlas or
batch as an ordinary list:

```js
new SpriteRenderer({
  wood: woodTexture,
  stone: [stoneTextureA, stoneTextureB],
  '*': defaultTexture,
});

new MeshRenderer({
  mesh: {
    debris: {
      stone: [rockA, rockB],
      wood: splinter,
    },
  },
});
```

Object branches are checked in JavaScript key order. The first matching branch that can resolve
wins. Nested keys require all tags along that path: the rock meshes above require both `debris`
and `stone`. Assign them with `tags: ['debris', 'stone'], tagSelection: 'all'` on an emitter.
If a matching outer branch cannot resolve a nested key, selection tries the next outer branch.

An array makes a stable random choice among its resolvable children. Nested arrays retain their
own random choice, rather than becoming one flattened distribution. Repeated resources can weight
the choice, while repeated texture objects still alias the same atlas tile. `textureIndex` and
`meshIndex` replace random choice within each selected array, wrapping integer indices (including
negative indices). They do not bypass tag constraints. Sprite `fps` advances within that branch;
`randomStartFrame: false` starts at its first eligible choice.

No matching resource hides the particle for that renderer, while simulation continues. A `'*'`
branch supplies a fallback and is tried after named keys, wherever it appears in the object.
Existing renderer `tags` filters still apply independently. Empty trees and cyclic input are rejected.

Inputs are static resource trees: recreate the renderer when replacing their structure. The exported
`TaggedValue<T>` type and selection helpers also support custom renderers. Prepare the tree once with
`prepareTaggedSelection(resources, isLeaf)` to obtain its flattened `values`, resource `tags` and branch graph.
Call `selectByTags(selection, tags, seed?, index?, offset?)` to obtain an index into `selection.values`,
or -1 for no match. `selectByTagsGPU(selection, tagMask, maskForTag, seed, index?, offset?)` builds the
matching TSL expression. Selection uses plain functions and prepared data; it does not rebuild the tree
per particle.
Plain resource arrays use direct index arithmetic; tag checks add no storage buffers. Resource keys
participate in the existing GPU tag registry and its 32-tag limit.

The [Destruction example](../examples/destruction.md) supplies five meshes as a plain random-choice array.
Wrap that array in a map such as `{ rock: { fracture: meshes } }` to require both tags instead.
