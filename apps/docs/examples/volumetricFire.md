---
title: "Volumetric Fire"
example: volumetricFire
---

[View live example](https://rzmps.rzmay.com/example/volumetricFire)

# Volumetric Fire <ExampleAttribution />

<ExampleTags />

A compact flame with temperature-driven color and mask breakup, cooling smoke, particle lights and heat shimmer.

<ExamplePreview />

## Particle System Configuration

This GPU-only preset needs an initialized native WebGPU renderer. The ten-second loop keeps emitting while
individual source particles live for 1.2 seconds. Gas persists independently after those particles die.
The simulation starts at **4 × 4 × 4 local units** and automatically grows or shrinks around the local origin,
with a maximum size of **16 × 16 × 16 local units**, configured through `spatialGridOptions.maxBounds`.
It remains open at the cap; outflow is absorbed rather than reflected back into the flame.
Scale the root system normally to change its world-space size.

<ExampleCode region="system" />

## Emitters

Fifty particles per second leave a small sphere with upward velocity 2.4 and radial speed one.
Their 0.1-unit scale and shrinking lifetime envelope make compact gas sources. Lower emission and
slightly longer source lifetimes produce flickering tongues rather than a uniformly filled column.

<ExampleCode region="emitters" />

## Modules

Density dissipation stays at 0.2, temperature dissipation at four, buoyancy at eight and velocity
dissipation at 0.15. Only a modest temperature multiplier changes density dissipation: cool gas uses
0.2 and fully hot gas 0.24. Cooling changes appearance quickly while smoke lasts slightly longer.
Simulation temperature normalization is independent of the renderer's temperature range.
Collision kills source particles at surfaces, and automatic fluid-collider collection blocks grid flow.

The grid uses 3 brick subdivisions plus 4 cell subdivisions. Its short rolling prediction covers the
occupied gas as well as source particles. Automatic shrinking remains enabled with the configured delay.

<ExampleCode region="modules" />

## Renderers

VolumeRenderer blends orange/yellow flames into gray smoke using physical temperature. The mask has
stronger strength and contrast in hot regions; cool smoke uses a gentler, slightly finer mask.
Two samples per voxel and 256 maximum ray steps control integration quality independently of opacity.
Two particle lights use brightness four; these lights illuminate the surrounding scene.

<ExampleCode region="renderers" />

## Heat distortion

The secondary transmitting distortion system and all its modules/renderers are configured in this preset file.
It uses the same normal-map asset as the sprite fire, with no import of another preset or system.
Its own scale, lifetime, color, alpha and mass are independent of the tiny gas source particles. The volume
renders before transmitting sprites so shimmer can sample the flame and background. The parent owns
subsystem timing and disposes the distortion texture when destroyed. Distortion uses its alpha map for
soft edges and disables the separate soft-particle depth prepass, avoiding an extra scene render each update.

<ExampleCode region="subsystems" />
