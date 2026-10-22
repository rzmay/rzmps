---
title: "Stylized Depth"
example: stylizedDepth
---

# Stylized Depth

Depth-based color, scale, speed, rotation, and velocity modules for stylized perspective effects.

[View live example](https://rzmps.rzmay.com/?preset=Stylized%20Depth)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

The system is offset to z=-6, with a 14-second loop and prewarm at 30 fps in the demo. Gravity is disabled so depth-dependent modules control motion. The broad initial volume supplies particles at many camera depths, making the styling differences visible at once.

<ExampleCode region="system" />

## Emitters

A 20×10×20 box emits 200 particles per second with lifetimes 7–12 seconds. Radial speed zero avoids a central explosion; velocity (0.01, 0.02, 0.3) creates a slow baseline drift. Initial scale 0.02 suits the renderer’s screen-oriented size configuration.

<ExampleCode region="emitters" />

## Modules

All five modules share depthRange [5, 24]. Distant particles shift from warm white toward cyan and alpha 0.5 while scale increases up to 2. Rotation grows from 0.12 to 1.6, and velocity and speed vary with normalized depth. These are camera-depth responses, so moving the camera can change appearance without changing particle age.

<ExampleCode region="modules" />

## Renderers

Unlit Circle sprites keep color differences independent of scene lighting. sizeAttenuation false suppresses ordinary perspective size falloff, allowing ScaleByDepth to provide the deliberate depth styling. Compare screenshots with a consistent camera to avoid mistaking camera changes for simulation differences.

<ExampleCode region="renderers" />

