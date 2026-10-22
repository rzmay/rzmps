---
title: "Metal Balls"
example: collisionSubEmitters
---

# Metal Balls

Collision-triggered subsystems and sound effects with physics-driven EQ filtering and live-cubemap rendering for convincing metallic surfaces.

[View live example](https://rzmps.rzmay.com/?preset=Metal%20Balls)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

The parent loops every five seconds under gravity and uses live cubemap reflections with intensity 3. A separate nonlooping spark system lasts 0.08 seconds as an emission window. It is triggered on contacts above impulse threshold 1.2; inheritance and impulse scaling let spark motion differ from the heavy parent.

<ExampleCode region="system" />

## Emitters

The balls emit at five per second with lifetime eight, keeping the population near 40 for manageable collision and audio costs. Each contact burst emits 3–6 sparks with lifetimes 0.18–0.42 and radial speed 0.5–2. The short emission window does not truncate those particle lifetimes.

<ExampleCode region="emitters" />

## Modules

The parent Collision module retains bounce 0.75 and dampen 0.05, so balls can strike surfaces repeatedly. The spark ColorOverLifetime module fades linearly. Subsystem impulse factors increase spark scale and speed for stronger contacts and align emission using the collision normal.

<ExampleCode region="modules" />

## Renderers

Lit sprites with metalness 0.6 and roughness 0.2 make live reflections visible. Collision audio uses volume 0.18, pitch variation 0.8–1.2, and impulse-dependent volume and low-pass filtering. Sparks use short 0.16-second emissive trails with depth writing disabled so their bright streaks layer cleanly. PNG previews cannot validate the sound itself.

<ExampleCode region="renderers" />

