---
title: Destruction
example: destruction
---

# Destruction

Metal balls emit surface fragments only when they collide. The incoming balls keep their own
metal material; the fragments inherit the impacted surface's maps and material parameters.
Choose the **UV debug** scene to inspect the texture footprint on its ramp, floor and wall.
The particle preset contains no scene geometry.

[View live example](https://rzmps.rzmay.com/?preset=Destruction)

<ExampleAttribution />
<ExamplePreview />

## Particle System Configuration

The setup follows Metal Balls: a bouncing parent starts a short burst on each impact.
`copyCollisionMaterial: true` enables copying for that burst. Scale and color inheritance are
zero so the small metal ball neither shrinks nor tints its surface fragments.
Both systems request GPU processing; WebGL uses the CPU collision path.

<ExampleCode region="system" />

## Emitters

Three balls per second spawn three units above the scene's particle root, with radial speeds of 2–4.
Each impact starts with a base burst of 6–10 fragments. `impulseAffectsCount: 0.5` multiplies this
by the square root of the impact impulse, so weaker contacts emit fewer pieces.
Base radial speeds of 0.25–1.5 are multiplied by impact impulse raised to 0.45, matching
Metal Balls' spark speed inheritance. The fragments use
the five Destruction GLBs at their authored scale (about 0.08–0.16 units wide).
The fragments have mass and two-to-three-second lifetimes; they are not normalized to unit size.

<ExampleCode region="emitters" />

## Modules

Both the incoming balls and fragments have gravity and collide with the scene.
Fragments use bounce 0.3 and contact damping 0.3, then fade during the last fifth of their lifetime.
RotationBySpeed reduces spin as they settle. The collision diameter uses representative model thickness,
so these small rocks do not inherit the former unit-sized collider. This remains a sphere approximation,
without rigid-body contact torque or a separate Coulomb-friction solver.
Contacts retain the material, UV coordinates and world-space UV gradients of the hit triangle.

<ExampleCode region="modules" />

## Renderers

The default batches Destruction_1 through Destruction_5, retaining their authored dimensions and UVs.
Each particle renders one of the five mesh variants. The demo always uses UV patches.

<ExampleCode region="renderers" />

`MaterialCopySampleMode.UVPatch` extends the contact triangle's mapping across each fragment,
retaining texture density and the impact UV. The renderer API also supports `Color`, which samples
source maps at the contact UV, and `Texture`, which maps the source onto the fragment's own UVs.
The demo keeps UV patch mode fixed. UV seams and other triangles are not reconstructed.

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

## Mesh Variants

MeshRenderer accepts `mesh: [meshA, meshB]`, `geometry: [geometryA, geometryB]`, or nested
[tag maps](../guides/tags.md#choosing-textures-and-meshes-by-tag). The same resource tree syntax works
with SpriteRenderer textures.
One entry uses InstancedMesh; multiple entries use BatchedMesh. Omit `meshIndex` for stable
random selection per particle, or supply a number/dynamic value. Integer indices wrap within the matched array branch, including negative values. GPU random selection uses particle identity, so compaction
and renderer children do not change a surviving particle's mesh choice.

Geometry lists share the supplied material options. Mesh lists may vary color, opacity, roughness,
metalness, normal scale and the supported diffuse/normal/roughness/metalness/alpha maps. Those
fields use atlas palettes and multiply collision inheritance independently. Other shader settings
must match; incompatible shader types, custom shader hooks and node materials are rejected.
Supported maps use UV0. Numeric material fields and map transforms update through palette snapshots.

Templates are static geometry snapshots; source transforms are not particle transforms. Material
array groups are preserved as parts of one selectable mesh. The batch normalizes owned geometry
copies and leaves source geometries, materials and textures caller-owned. Recreate the renderer
when replacing template geometry or material objects.

WebGL uses multi-draw where available. Three.js's WebGPU BatchedMesh submits individual draws and
cannot use the particle stream's instanced indirect draw. The GPU path reserves candidate parts
per particle slot and masks unselected variants in the shader, preserving GPU-only simulation,
LOD/children identities and material copying without readback or extra storage bindings. Its draw
and vertex cost therefore grows with template count and GPU particle capacity. Keep the variant
list and capacity modest; the single-mesh path retains the instanced indirect draw.
