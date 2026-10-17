---
title: "Additive Smoke"
example: additiveSmoke
---

# Additive Smoke

Additive blending with soft particles and layered lifetime color ramps for luminous smoke.

[View live example](https://rzmps.rzmay.com/?preset=Additive%20Smoke)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

A 10-second loop and 4.5-second particle lifetime maintain a slow plume. Gravity modifier -0.015 adds gentle upward acceleration. The simulation matches the ordinary smoke structure, making the blending change easy to compare using the same camera and warmup.

<ExampleCode region="system" />

## Emitters

The cone source emits 36 particles per second, giving roughly 162 live particles before culling. Scale 2.5 creates overlapping patches, but initial alpha 0.35 and the darker color range reduce the brightness contributed by each patch. Upward velocity 0.75 and radial speed 0.18 hold the plume together near the base.

<ExampleCode region="emitters" />

## Modules

Low-frequency noise (0.8) moves the smoke in broad curls, with less vertical than horizontal strength. Velocity limits and drag contain the flow. Growing scale from 0.35 to 1.8 widens older particles, while the fade envelope and varied angular velocities prevent visible rectangular births and repeated texture alignment.

<ExampleCode region="modules" />

## Renderers

The lit smoke sprites use AdditiveBlending, so overlapping particles brighten the scene rather than darkening it like opaque soot. The low starting alpha counterbalances that accumulation. Roughness 1 and spherical normals retain lighting cues, while soft-particle distance 1 blends contacts with scene geometry.

<ExampleCode region="renderers" />

