---
title: "Bubbles"
example: bubbles
---

# Bubbles

Refractive sprite transmission with spherical normals and size-driven distortion. Both continuous sounds and collision-triggered bubble pops.

[View live example](https://rzmps.rzmay.com/?preset=Bubbles)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

The 10-second loop uses a small gravity modifier 0.05 and live cubemap reflections. Particle lifetimes 7–12 seconds allow slow movement and collisions. The physics remains ordinary particles; transmission and distortion create the bubble appearance.

<ExampleCode region="system" />

## Emitters

Eight particles per second from a radius-0.5 sphere yield around 76 particles at average lifetime before contact losses. Scale 0.25–1 gives varied bubble sizes, and radial speed 1–3 spreads them. Mass 0.25 changes the physics response relative to the heavier collision examples.

Uniform scale values and color strings use the standard input shortcuts.

<ExampleCode region="emitters" />

## Modules

Gentle noise strength (0.2, 0.05, 0.2) adds lateral wobble. Collision lifetimeLoss 1 removes bubbles on contact, driving their pop cue. Scale grows rapidly during the first fifth of life rather than appearing at full size immediately. DistortionBySize maps size 0–1 to distortion multiplier 0–1, emphasizing larger bubbles.

<ExampleCode region="modules" />

## Renderers

The lit sprite combines spherical normals, low roughness 0.15, transmission 0.7, and distortion strength -0.05 to suggest a curved transparent shell. Only ratio 0.15 of particles play the looping bubble track, while collisionRatio 1 permits every bubble to pop. Size lowers pitch and slightly increases volume; inspect sound in the interactive demo as well as the visual preview.

<ExampleCode region="renderers" />

