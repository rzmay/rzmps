---
title: "Splatter"
example: splatter
---

# Splatter

Matte, multicolored paintballs leave long-lived splatters matching their color and size, with randomized surface rotation. Select a scene with collision geometry, such as Checkerboard.

[View live example](https://rzmps.rzmay.com/?preset=Splatter)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

An eight-second loop throws paintballs from height 3.5 under gravity. The source particles disappear on impact, while their paint stays on the surface for 90 seconds. Use Checkerboard for a clear floor or a collision scene to catch paint on several surfaces. Known mesh contacts place decals directly; backends without mesh identity search opposite the collision normal so walls receive paint as well as floors. The factory owns and disposes its splatter color/alpha map, normal map, and template material when the root system is destroyed.

<ExampleCode region="system" />

## Emitters

Five balls per second receive colors from a five-color palette and uniform diameters between 0.2 and 0.45. Radial speed 3 scatters their trajectories, with a small upward launch velocity before gravity pulls them down. Random Z rotation covers a full turn; it becomes the decal's surface roll at impact. Source lifetime eight seconds is a fallback for balls that miss scene geometry.

<ExampleCode region="emitters" />

## Modules

Collision consumes the complete source lifetime on the first contact. The decal listener captures color, scale, and rotation before the ball dies. A backend supplying a mesh projects directly at that contact. Backends without target identity use a bounded downward ray to find the landing surface. This also works with asynchronous GPU collision events, whose particle velocity may already reflect the bounce response.

<ExampleCode region="modules" />

## Renderers

The balls reuse the Spheres preset's lit circular sprites and spherical normals, with roughness raised to 0.95 and no metalness for a matte paint finish. The rough decal material uses splat2.png for its white color and transparent silhouette, together with splat2_norm.jpg at normal strength 0.65 for raised paint detail. The color map is sRGB; the normal map stays in linear data space. Each cloned material inherits its source ball's exact color. Full scale inheritance gives each splatter a footprint three times the ball diameter, so larger balls leave proportionally larger marks. Marks stay opaque for the first 85 percent of their 90-second lifetime, then fade smoothly. Capacity 512 accommodates roughly 450 steady-state marks at five impacts per second.

<ExampleCode region="renderers" />

[Fire](./fire.md) demonstrates textured scorch marks. See [Surface Decals](../guides/decals.md) for selection callbacks, inheritance, lifetimes, and supported targets.
