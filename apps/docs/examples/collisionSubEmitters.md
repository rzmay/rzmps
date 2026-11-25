---
title: "Metal Balls"
example: collisionSubEmitters
---

[View live example](https://rzmps.rzmay.com/example/collisionSubEmitters)

# Metal Balls <ExampleAttribution />

<ExampleTags />

A metal ball should announce an impact through more than a change of direction. This preset layers a short spark
burst and a contact sound onto bouncing, reflective balls, tying those cues to the force of each collision.

<ExamplePreview />

## Load the impact sound

Decode the contact sound before creating the renderers so the first collision can play it. The helper records the
clip's source URL for the demo's code exporter; it does not change the sound. Keep this setup separate from volume
and impulse tuning, which control how the loaded clip is used.

<ExampleCode region="system:audioSources" />
<ExampleCode region="system:resources" />

## Make the balls feel solid

The parent emits a small stream under gravity. Long particle lifetimes let the same ball strike the scene repeatedly.
The Collision module uses a lively bounce with modest damping, so contacts remain easy to hear and see. Choose a
scene with geometry; the live cubemap and metallic material need an environment to reflect.

<ExampleCode region="emitters:1" />
<ExampleCode region="modules:1" />

## Make stronger contacts throw brighter fragments

A separate spark system is triggered only above an impulse threshold. Its brief emission window starts a burst;
the sparks' own lifetimes let their streaks finish afterward. Impulse-dependent speed and scale connect the size of
the response to the hit. The collision normal supplies a useful outward direction instead of scattering sparks
through the struck surface.

<ExampleCode region="system:2" />

## Let sound and reflections reinforce the material

Low roughness and metalness make the balls look reflective. Contact audio varies in pitch and responds to impulse,
while filtering changes its tone. Keep the sound below the level where repeated bounces blend into one loud bed.
The short emissive spark trails provide a contrasting flash. Use the live demo with audio enabled to tune how the
visual and audible cues meet.

<ExampleCode region="renderers:1" />

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />

Connect the secondary behavior to the root with the relationships below. The root owns child updates; their
inheritance and event filters decide when each layer starts and which source it follows.

<ExampleCode region="system:connections" />
