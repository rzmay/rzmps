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
A render-only GasModule multiplies the existing mask contrast by up to 1.6 in sparse hot tongues,
reduces it toward 0.75 in dense hot cores, and approaches a neutral multiplier as gas cools.
The original simulation and renderer values remain unchanged; the module allocates no gas field.
Collision kills source particles at surfaces, and automatic fluid-collider collection blocks grid flow.

The grid uses 3 brick subdivisions plus 3 cell subdivisions. `maxVolumeQuality: 8` caps cell width
at 8 / 64 = 0.125 without changing the sixteen-unit physical bounds cap. Automatic quality has
hysteresis in both directions and prepares replacements before adopting them. Its short rolling prediction covers the
occupied gas as well as source particles. Automatic shrinking remains enabled with the configured delay.

<ExampleCode region="modules" />

## Renderers

VolumeRenderer blends orange/yellow flames into gray smoke using physical temperature. The mask has
stronger strength and contrast in hot regions; cool smoke uses a gentler, slightly finer mask.
Two samples per voxel and 256 maximum ray steps control integration quality independently of opacity.
Hot, dense flame regions use `emissive: 1` shaped by temperature and density, retaining their transported
fire color under colored scene lights. Cool smoke remains externally lit. This self-lighting blend does
not illuminate objects or other volume samples; the particle lights provide that illumination.
Two particle lights start at brightness four and fade with normalized particle lifetime. Their
brightness follows `4 * (1 - time) ** 2`, with particle alpha applied as well, so aged flame sources
stop lighting the scene at full strength. Each pooled light reevaluates its source parameters.
`lightingGridOptions` uses 0.25-unit probes and a fixed sixteen-unit lighting distance, inheriting
two cascades, four finest directions, four interval samples and one scattering iteration. It supplies their light and the selected scene's lights/environment to
the volume. The renderer owns its lighting grid and refreshes it as those inputs change.
Both quality limits are eight, so the 3+3 grid starts and stays at a 0.125-unit cell width.
This avoids oversampling a compact initial domain; physical bounds still grow and shrink independently.

<ExampleCode region="renderers" />

## Heat distortion

The secondary transmitting distortion system and all its modules/renderers are configured in this preset file.
It uses the same normal-map asset as the sprite fire, with no import of another preset or system.
Its own scale, lifetime, color, alpha and mass are independent of the tiny gas source particles. The volume
renders before transmitting sprites so shimmer can sample the flame and background. The parent owns
subsystem timing and disposes the distortion texture when destroyed. Distortion uses its alpha map for
soft edges and disables the separate soft-particle depth prepass, avoiding an extra scene render each update.

<ExampleCode region="subsystems" />

Density noise follows local flow more strongly in cool smoke, while hot flame regions retain low stretch.
