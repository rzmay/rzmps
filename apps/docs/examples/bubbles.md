---
title: "Bubbles"
example: bubbles
---

[View live example](https://rzmps.rzmay.com/example/bubbles)

# Bubbles <ExampleAttribution />

<ExampleTags />

These bubbles should feel like thin, moving shells: they wobble, distort the scene behind them, and disappear with
a pop when they touch geometry. The Cornell Box scene makes their highlights and refraction easy to see.

<ExamplePreview />

## Prepare the shell textures and sounds

Load the transparency/distortion textures and decode the continuous and pop sounds before creating the system.
The small audio helper records where a clip came from so the demo can offer a useful code export. Your own application
can keep its asset URLs alongside its audio-loading code in the same way.

<ExampleCode region="system:audioSources" />
<ExampleCode region="system:resources" />

## Begin with a varied, gentle stream

A small sphere source and varied size keep the bubbles from appearing as identical beads. Radial speed separates them,
and their long lifetimes leave time for drifting and contact. A small gravity modifier keeps the motion gentle.
Live cubemap reflections supply environmental cues; they do not replace the particles' ordinary motion.

<ExampleCode region="emitters" />

## Let them form, wobble and pop

The early cubic scale ramp makes each bubble grow into view. Gentle sideways noise adds wobble, while the collision
module removes a bubble on contact. DistortionBySize makes larger bubbles bend the background more strongly, so the
size variation affects appearance as well as silhouette. Use a scene with collision geometry to see the pop behavior.

<ExampleCode region="modules" />

## Combine a transparent shell with a restrained sound bed

Spherical normals, low roughness, transmission and a distortion map suggest a curved surface on a billboard. The
looping bubbling track is applied to only some particles so it does not overwhelm the mix; every collision can play
a pop. Larger bubbles sound deeper. Adjust the material under scene lighting, then enable audio to tune the relative
level of the continuous bed and individual pops.

<ExampleCode region="renderers" />

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />
