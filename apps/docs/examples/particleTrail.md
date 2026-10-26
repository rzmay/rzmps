---
title: "Particle Trail"
example: particleTrail
---

# Particle Trail

Per-particle trail rendering with inherited color and alpha over moving particles.

[View live example](https://rzmps.rzmay.com/?preset=Particle%20Trail)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

The 2-second loop continuously feeds particles with 2.5-second lifetimes. Gravity (0, -1.5, 0) bends initially upward trajectories into arcs. Particle and trail lifetimes differ, allowing the path to linger after its source has moved on.

<ExampleCode region="system" />

## Emitters

Only eight particles per second are needed because their trails supply most of the visible coverage. Emission starts within a radius-0.15 sphere, with upward velocities 4–6 and lateral components between -1.5 and 1.5. The 0.15 particle scale keeps each moving source compact.

<ExampleCode region="emitters" />

## Modules

TransformByNoise uses strong horizontal components (100) and zero vertical strength at frequency 5. The result strongly perturbs the lateral path while gravity and initial vertical velocity still shape its height. The large strength is a visible parameter to inspect carefully when adapting the effect to another scene scale.

<ExampleCode region="modules" />

## Renderers

Particle mode gives every selected particle its own trail, with ratio 1. Trail lifetime 0.75 and minimum vertex distance 0.05 balance persistence against vertex count. Width 0.18 tapers at both ends; the cyan-to-pink gradient makes progression along the path readable. dieWithParticles false lets older trail segments finish fading.

<ExampleCode region="renderers" />

