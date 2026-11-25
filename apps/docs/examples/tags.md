---
title: "Cubes and Spheres"
example: tags
---

[View live example](https://rzmps.rzmay.com/example/tags)

# Cubes and Spheres <ExampleAttribution />

<ExampleTags />

This example puts two distinct visual behaviors in one particle system: cubes tumble and fade, while spheres grow
and collide. Tags express that artistic split without requiring two separately updated systems.

<ExamplePreview />

## Give each birth one role

The emitter distributes the `cubes` and `spheres` tags rather than giving every particle both. The shared source and
color palette keep the populations visually related. Zero gravity makes their different treatment easier to see;
longer lifetimes leave enough time for growth and rotation to become apparent.

<ExampleCode region="emitters" />

## Make the two roles behave differently

Cube-tagged particles receive rotation and a late alpha fade. Sphere-tagged particles grow and collide with scene
geometry. Each module carries the tag for the group it should affect. If a new behavior belongs to both groups,
leave its filter shared; if it belongs to just one, match that group's tag deliberately.

<ExampleCode region="modules" />

## Match appearance to the same roles

One renderer draws spherical billboards, the other box meshes. Their matching filters ensure each birth gets the
intended appearance rather than both. Shadows make the boxes' faces visible, while spherical normals round the
sprite lighting. Add a collision scene to see the sphere-only contacts. See [Using Tags](../guides/tags.md) when adapting
the pattern to more groups.

<ExampleCode region="renderers" />

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />
