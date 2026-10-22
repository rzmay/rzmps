---
title: "Snow"
example: snow
---

# Snow

Depth-based fading, noise-driven motion, warmup, and broad low-cost emission.

[View live example](https://rzmps.rzmay.com/?preset=Snow)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

The snow is positioned five units above the origin. A 10-second loop with prewarm fills the scene before the ordinary demo begins; the preview CLI instead uses its explicit warmup count. Gravity modifier 0.025 gives a slow fall over the long 16-second particle lifetime.

<ExampleCode region="system" />

## Emitters

A 30×0.1×30 box distributes snow across a wide area. Rate 200 can sustain about 3200 particles at full lifetime, so the 0.25-unit flakes remain individually small. Radial speed is zero and initial vertical velocity is -0.35, avoiding an outward blast from the box.

<ExampleCode region="emitters" />

## Modules

Horizontal noise strength 0.28 and vertical strength 0.02 create drifting flakes. Velocity limits and drag prevent rapid falling. A small constant rotation animates the snow silhouette. Depth fades reduce distant alpha between depths 6 and 24 and remove flakes very near the camera between depths 1 and 2; the lifetime envelope softens population turnover.

<ExampleCode region="modules" />

## Renderers

The snowflake alpha texture provides detail using one lit billboard per particle. Normal lighting 0.25 and spherical normals 0.1 keep shading subtle instead of making flakes look like balls. This is less geometric work than individually modeled snowflakes at the same population.

<ExampleCode region="renderers" />

