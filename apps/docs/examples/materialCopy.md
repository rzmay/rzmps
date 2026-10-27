---
title: Material Copy
example: materialCopy
---

# Material Copy

Metal balls emit surface fragments only when they collide. The incoming balls keep their own
metal material; the fragments inherit the impacted surface's maps and material parameters.
Choose the **UV Debug Surfaces** scene to inspect the texture footprint on its ramp, floor and wall.
The particle preset contains no scene geometry.

[View live example](https://rzmps.rzmay.com/?preset=Material%20Copy)

<ExampleAttribution />
<ExamplePreview />

## Particle System Configuration

The setup follows Metal Balls: a bouncing parent starts a short burst on each impact.
`copyCollisionMaterial: true` enables copying for that burst. Scale and color inheritance are
zero so the small metal ball neither shrinks nor tints its surface fragments.
Both systems request GPU processing; WebGL uses the CPU collision path.

<ExampleCode region="system" />

## Emitters

Five balls per second fall from the scene's particle root. Each impact emits ten fragments,
0.2–0.4 units across, with independent lifetimes.

<ExampleCode region="emitters" />

## Modules

Collision discovers the scene meshes. Contacts retain the material, UV coordinates and world-space
UV gradients of the hit triangle. The particle system works in other collision scenes too.

<ExampleCode region="modules" />

## Renderers

The default uses mesh fragments. Call the factory with `{ sprites: true }` to test lit sprites
instead; each particle has one visual renderer. Incoming balls never copy a surface material.

<ExampleCode region="renderers" />

To compare modes, call the factory with `{ sampleMode: MaterialCopySampleMode.Color }` or
`MaterialCopySampleMode.Texture`. The default `UVPatch` extends the contact triangle's mapping
across the fragment, retaining texture density and the impact UV. `Color` samples each source map
at that UV, producing a uniform sampled value. `Texture` maps the source onto the fragment's own UVs.
With the UV debug scene, these respectively show a local chart patch, a solid sampled color, or the
whole repeating chart. UV seams and other triangles are not reconstructed.

For an independent system, set `materialTarget` on its renderer or call
`renderer.copyMaterial(material)`. Copied color, opacity, roughness and metalness multiply the
configured particle values; white and one preserve the source. Normal maps perturb the destination
normal. Sprite masks and animation UVs remain independent of copied maps. The built-in patch path
supports UV0 and MeshRenderer/SpriteRenderer; custom backends can provide `material` and `surface`
on `CollisionHit`, and custom renderers can implement copying hooks.

Numeric values and transforms are snapshots cached until the system tree is destroyed. Source
textures remain shared. Color mode samples during rendering, so rebaked texture changes remain visible.
Billboard patches preserve chart density and shear in the sprite plane.

TextureAtlas bakes GPU tiles with extruded borders, fixed resolution and no mipmaps. Repeated texture
objects alias existing tiles. Unchanged updates issue no atlas draw calls. Render-target textures
require `atlas.invalidate(texture)` before `update(renderer)` when their contents change externally.
No CPU pixel readback is used. Each atlas belongs to one initialized Three.js renderer.
Its `sample(tile, coordinates)` method exposes a TSL node with dynamic tile selection.

Independently, a SpriteRenderer texture list builds an atlas and chooses a stable texture per particle;
`textureIndex` selects explicitly. This example uses plain incoming balls to make collision inheritance
unambiguous.
