---
title: "LOD Stress Test"
example: lodStress
---

# LOD Stress Test

Unified population LOD with density compensation.

[View live example](https://rzmps.rzmay.com/?preset=LOD%20Stress%20Test)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

The system caps simulation at 50000 particles and loops over 10 seconds. Its single `lod` setting scales emission and permanently removes particles above the current birth-priority threshold as the camera moves away. Survivors run every simulation step. Moving closer replenishes the population through ordinary emission.

<ExampleCode region="system" />

## Emitters

Rate 1800 with lifetime 2.5–5 sustains roughly 6750 simulated particles at full quality. System LOD begins at distance 10, with quality 0.7 and up to five levels. Emitters allocate only the reduced population; each new particle receives an eligible LOD priority.

<ExampleCode region="emitters" />

## Modules

Velocity, noise, scale, and alpha modules update every surviving particle each step. Noise strength 2.5 and frequency 2.2 exercise simulation work that population LOD can eliminate without motion stutter.

<ExampleCode region="modules" />

## Renderers

The lit Circle renderer has artistic children disabled. `CompensationMode.Children` adds density copies only when system LOD reduces quality. Automatic local spacing estimates spread compensation copies; they inherit their immediate parent’s scale and opacity. All children remain outside simulation. Soft-particle distance 1 reduces intersections.

<ExampleCode region="renderers" />

