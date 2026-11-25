---
title: "Additive Smoke"
example: additiveSmoke
---

[View live example](https://rzmps.rzmay.com/example/additiveSmoke)

# Additive Smoke <ExampleAttribution />

<ExampleTags />

This plume should feel luminous, as if light is scattered through a cloud. Its motion resembles the ordinary
[Smoke](./smoke.md) preset, but additive blending makes overlapping wisps contribute light instead of building a dark mass.

<ExamplePreview />

## Build a plume before adding glow

A broad cone, slow upward velocity and a small buoyancy term establish a recognizable smoke column. Long-lived,
overlapping sprites fill the gaps between births. The darker starting colors and lower alpha are deliberate: additive
overlap can wash out the shape if each particle starts too bright. Increase brightness in small steps after the plume
has enough overlapping layers.

<ExampleCode region="emitters" />

## Break up the column and fade its edges

Noise creates sideways curls while drag keeps motion contained. The lifetime scale ramp makes older wisps spread,
and the opacity envelope avoids hard appearances and disappearances. Random angular velocity rotates the mask so
neighboring particles do not reveal the same silhouette. Keep these changes slow enough that the smoke still feels
like a drifting cloud rather than flickering sparks.

<ExampleCode region="modules" />

## Make overlap read as light

The renderer uses additive blending with a smoke alpha mask. Overlapping regions brighten, so they suggest a luminous
core. Rough, softly lit billboards still respond to the scene, and soft-particle fading helps them meet nearby geometry.
Use ordinary smoke blending instead when the intended result is dense soot that should darken what is behind it.

<ExampleCode region="renderers" />

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />
