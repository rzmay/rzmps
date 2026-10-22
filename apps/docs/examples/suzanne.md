---
title: "Suzanne"
example: suzanne
---

# Suzanne

Mesh-surface emission from a model with lit sprite rendering.

[View live example](https://rzmps.rzmay.com/?preset=Suzanne)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

This continuously looping 10-second system emits from a loaded model. Geometry is cloned before transformation so the GLTF asset’s original mesh is not modified. The source applies rotateX(-90), which Three.js interprets in radians; this documents the current transform rather than assuming it means a quarter-turn.

<ExampleCode region="system" />

## Emitters

EmissionSource.Surface samples Suzanne’s geometry at 256 particles per second. Lifetime 2.2 gives roughly 563 visible particles before culling, enough to outline the model. Initial speed and velocity are zero, while radial speed 1.1 supplies source-directed motion; small scale 0.1125 keeps the sampled shape legible.

<ExampleCode region="emitters" />

## Modules

The color module keeps the cyan tint and applies a cubic alpha fade. Late fading preserves a recognizable shell for most of each particle’s life, then reduces visible popping as particles expire. No additional noise or force module obscures the model-based emission pattern.

<ExampleCode region="modules" />

## Renderers

Circle sprites with lit material render each sample without instancing the entire Suzanne mesh per particle. The model is only the emission source. This makes the surface sampling easy to see while avoiding a scene filled with hundreds of full model instances.

<ExampleCode region="renderers" />

