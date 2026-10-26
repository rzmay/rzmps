---
title: "Smoke"
example: smoke
---

# Smoke

Lit smoke sprites with soft particles and lifetime scale/color shaping.

[View live example](https://rzmps.rzmay.com/?preset=Smoke)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

The 10-second loop sustains a plume while particles live for 4.5 seconds. The small negative gravity modifier reverses the default downward acceleration, adding slow buoyancy. Long particle lifetimes let the plume accumulate and spread instead of looking like short flame tongues.

<ExampleCode region="system" />

## Emitters

A cone of radius 0.75 and height 1.2 provides a broad source. Rate 36 and lifetime 4.5 imply about 162 live particles at steady emission. Upward velocity 0.75 and radial speed 0.18 favor a column with modest spread. Scale 2.5 overlaps the low-opacity, alpha-0.55 sprites into a continuous volume.

Uniform scale values and color strings use the standard input shortcuts.

<ExampleCode region="emitters" />

## Modules

Noise is stronger horizontally (0.65) than vertically (0.35), producing rolling lateral motion. Velocity limits and drag prevent indefinite acceleration. The scale multiplier grows from 0.35 to 1.8, representing dispersal, and the alpha curve hides the first fifth and final quarter of the lifetime. Random angular velocity breaks up repeated texture orientation.

<ExampleCode region="modules" />

## Renderers

Lit sprites use the smoke alpha image as their silhouette. Roughness 1 avoids glossy highlights; spherical normals 1 and normal lighting 0.5 give each billboard some volume under scene lighting. Soft-particle distance 1 reduces hard lines where the smoke intersects geometry.

<ExampleCode region="renderers" />

