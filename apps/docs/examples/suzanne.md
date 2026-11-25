---
title: "Suzanne"
example: suzanne
---

[View live example](https://rzmps.rzmay.com/example/suzanne)

# Suzanne <ExampleAttribution />

<ExampleTags />

The goal is to reveal a model's surface through particles. Suzanne supplies the emission shape; the particles
leaving it are small cyan sprites, not copies of the whole model.

<ExamplePreview />

## Load a surface to sample

Load the GLTF and clone its geometry before orienting it. That keeps the imported asset intact and gives the emitter
its own source geometry. Adapt the clone's transform to your model; Three.js geometry rotations use radians.
The source is ready before the particle system is constructed.

<ExampleCode region="system:resources" />

## Use a recognizable surface as the source

The factory loads the GLTF, clones its geometry and orients the clone for emission. Sampling `EmissionSource.Surface`
places births on that geometry. Small particle sizes and a steady stream let the outline remain visible while radial
speed carries particles away from it. Lower that speed to hold a shell around the model, or increase it to make the
surface appear to dissolve outward.

<ExampleCode region="emitters" />

## Preserve the outline before fading it

The cyan color and cubic alpha fade keep a clear shell early in life, then soften its disappearance. No noise layer
is added because the surface distribution is the feature being taught. Add motion only after the source shape is
recognizable, otherwise it becomes difficult to tell whether a change comes from emission or later movement.

<ExampleCode region="modules" />

## Draw samples rather than model copies

Lit circular sprites give each sample a compact, soft-edged appearance. The model remains an emission resource.
Compare [Suzanne Instances](./suzanneInstances.md) if you want every particle to be a miniature model instead of a
point sampled from its surface.

<ExampleCode region="renderers" />

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />
