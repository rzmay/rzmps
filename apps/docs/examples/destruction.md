---
title: Destruction
example: destruction
---

[View live example](https://rzmps.rzmay.com/example/destruction)

# Destruction <ExampleAttribution />

<ExampleTags />

A hard impact should feel as though it removes material from the struck surface. Here bouncing metal balls leave
cracks and throw small fragments whose appearance comes from that surface, rather than from the ball.

<ExamplePreview />

## Begin with a solid incoming object

The root launches metal balls above the scene. Gravity and collision make the contacts easy to follow. Reflective
shading distinguishes the incoming object from the fragments it will create. Choose **UV debug** to see the crack
and fragment textures against a floor, wall and ramp; the particle factory does not add that geometry itself.

<ExampleCode region="emitters:1" />
<ExampleCode region="modules:1" />

## Make hard hits leave a crack

The collision-only decal renderer ignores soft contacts. Its size responds to impulse, so a harder strike can leave
a stronger mark. Complete normal, opacity, roughness and ambient-occlusion map sets keep each crack's details aligned.
The copied surface color remains visible beneath those details. The opacity mask blends their edges into the wall,
and independent projector roll prevents repeated impacts from looking like identical stamps.

<ExampleCode region="renderers:3" />
<ExampleCode region="renderers:1" />

## Throw fragments that belong to the surface

A collision-triggered child burst responds to impact strength. Scale and color inheritance are disabled so the
small metal ball does not tint or shrink the debris. `MaterialCopy` gives the fragments the struck surface's material
and UV patch. Their authored mesh sizes, bounce and spin let them settle like small pieces; a late fade clears them
without a sudden disappearance. Adjust fragment count and launch speed to change how violent the impact feels.

<ExampleCode region="system:2" />

The mesh list supplies varied silhouettes; it does not change the incoming ball. See
[Material Copying](../guides/material-copying.md) for other sampling modes and [Surface Decals](../guides/decals.md)
when adapting the crack to another material.

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />

Connect the secondary behavior to the root with the relationships below. The root owns child updates; their
inheritance and event filters decide when each layer starts and which source it follows.

<ExampleCode region="system:connections" />
