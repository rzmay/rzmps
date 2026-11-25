---
title: "Cube Instances"
example: cubes
---

[View live example](https://rzmps.rzmay.com/example/cubes)

# Cube Instances <ExampleAttribution />

<ExampleTags />

Here the particles should clearly have faces, edges and tumbling motion. A shared box mesh gives them a geometric
silhouette, while the rest of the preset stays simple enough to separate movement from shading.

<ExamplePreview />

## Scatter a readable group of cubes

Zero gravity leaves the initial outward motion easy to follow. Sizes vary within a restrained range, and a discrete
palette keeps the cubes colorful without producing intermediate hues. The emitter scale multiplies the small box
geometry, so tune both together when adapting the preset to another scene's units.

<ExampleCode region="emitters" />

## Tumble, then disappear quietly

Angular velocity varies across axes so the cubes reveal different faces instead of spinning as one synchronized group.
The cubic alpha fade keeps them readable early in life and removes them near the end. There is no extra force or noise
layer: add those only if the intended motion needs more than the emitter's initial trajectory.

<ExampleCode region="modules" />

## Let light describe real faces

A standard material and cast/receive shadows make the box geometry legible against the scene. Use shadow-enabled
lights to see that contact cue. Unlike [Spheres](./spheres.md), the rounded appearance is not being synthesized on a
billboard: every visible face belongs to the shared mesh.

<ExampleCode region="renderers" />

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />
