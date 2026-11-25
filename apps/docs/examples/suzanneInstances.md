---
title: "Suzanne Instances"
example: suzanneInstances
---

[View live example](https://rzmps.rzmay.com/example/suzanneInstances)

# Suzanne Instances <ExampleAttribution />

<ExampleTags />

Every particle in this example should be recognizable as a small Suzanne model. It contrasts with the surface-emission
example, where Suzanne only determines where circular particles begin.

<ExamplePreview />

## Prepare a model as the particle template

Load the GLTF and clone its geometry before building the renderer. The clone's orientation becomes the template for
every particle, so choose that transform with your model's forward direction in mind. Geometry rotations use radians.
The palette is shared setup, while each birth chooses its own color.

<ExampleCode region="system:resources" />

## Give each model space and direction

The factory loads and clones the model geometry for the renderer. A restrained stream, varied scales and zero gravity
keep individual silhouettes readable. Directional alignment turns each model with its launch direction, while a
four-color palette distinguishes neighboring instances. Widen the source before increasing density if the models
begin to overlap too heavily.

<ExampleCode region="emitters" />

## Keep the model recognizable until it leaves

A cubic alpha fade removes instances late in life. No additional motion module distorts the simple flight, so shape
and alignment carry the effect. This is a useful starting point for debris or repeated props: establish the silhouette
first, then add the particular spin or acceleration that your intended material calls for.

<ExampleCode region="modules" />

## Share geometry, keep geometric shading

MeshRenderer uses the loaded geometry with a standard material and shadows. Faces and shadows provide cues that a
billboard would not. The source mesh is a template for appearance, not the emission surface. See
[Suzanne](./suzanne.md) for the opposite use of the same asset.

<ExampleCode region="renderers" />

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />
