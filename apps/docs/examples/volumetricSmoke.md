---
title: "Volumetric Smoke"
example: volumetricSmoke
---

[View live example](https://rzmps.rzmay.com/example/volumetricSmoke)

# Volumetric Smoke <ExampleAttribution />

<ExampleTags />

A continuous cloud of rolling warm-gray smoke with a subtle reddish tint.

<ExamplePreview />

## Particle System Configuration

This native WebGPU preset continuously emits through a repeating ten-second loop. Directional automatic padding and delayed shrinking
keep the domain aligned with source motion and existing smoke support.

<ExampleCode region="system" />

## Emitters

White source particles continuously leave a small sphere with radial and upward velocity.
Short lifetimes and shrinking sizes keep the source compact; the Eulerian field retains smoke after
each particle expires. There is no pulsed emission gate. The renderer supplies the warm-gray tint.

<ExampleCode region="emitters" />

## Modules

Density/color, temperature and velocity dissipate independently. Buoyancy lifts warm gas, scalar
diffusion spreads concentration, turbulence noise adds motion, and vorticity confinement preserves
rolling detail. Turbulence strength and frequency are both 1.5, adding smaller-scale motion without
strongly pushing the entire cloud sideways. Temperature emission cools over particle lifetime. Turbulence settings use the
`turbulenceNoiseStrength`, `turbulenceNoiseFrequency`, `turbulenceNoiseSpeed` and `turbulenceNoiseOctaves` names.

Upward lifetime force, particle noise motion, shrinking source sizes and lifetime alpha fade shape
the source. ColorOverLifetime changes alpha while particle color remains white.
Source collision uses lifetime loss one and the grid discovers fluid colliders automatically.
Large mesh-collider sets share an occupancy atlas to stay within WebGPU sampled-texture limits.
Closed meshes rendered with `BackSide` are collected as containers with a fluid interior; open sheets
remain surface obstacles.

Source strength uses emitted mass per second, and scalar diffusion uses world units²/second.
The source emits 0.5 mass units per particle per second before particle mass/alpha weighting,
and diffusivity is 0.005 world units²/second. Density dissipation of 0.35 lets the stronger source
accumulate into a larger cloud while gentle diffusion broadens its footprint. Coarser automatic quality
no longer increases physical emission or diffusion rate.

<ExampleCode region="modules" />

## Renderers

The renderer's warm-gray `color` multiplies transported particle color; white particles preserve this
tint. The `densityNoiseStrength`, `densityNoiseContrast`, `densityNoiseFrequency` and `densityNoiseSpeed`
settings supply visual breakup independently of simulated turbulence. Two samples per voxel and a
256-step limit resolve masked detail without intentionally changing opacity.
Sampling is relative to cell width: when cells coarsen from 0.125 to 0.25 units, four samples per voxel
restore the 0.0625-unit spacing provided by two samples at the finer tier. Larger bounds can also reach
the maximum-step budget. Increasing either sampling control costs rendering work; density-noise frequency
stays fixed in simulation space, independently of the grid tier.


There is no temperature-driven tint or lifetime color gradient. Simulation lighting/shadows can vary
brightness, while the transported smoke keeps its single slightly reddish gray hue.
`lightingGridOptions` enables managed lighting with 0.25-unit probes and a fixed sixteen-unit distance.
It inherits two cascades, four finest directions, four interval samples and one scattering iteration. Moving scene lights,
new lights entering range and HDRI changes refresh lighting even when particle simulation is paused.

<ExampleCode region="renderers" />

The demo uses three brick subdivisions and three cell subdivisions for its realtime performance budget.
`minVolumeQuality: 8` starts it at a 0.125-unit cell width rather than oversampling its compact initial
domain. Larger smoke support can still request a coarser automatic tier.

Density noise stretches along local flow, tapering to an unstretched mask as the gas comes to rest.

## Render sampling quality

Use `VolumeRenderer.samplesPerVoxel` for finer visual sampling at coarse gas qualities; the demo GUI
calls it **Samples Per Voxel**. Increase `steps` too if a larger ray interval reaches that sample budget.
This changes rendering cost and sample spacing, not gas density or simulation resolution. No automatic
sampling or appearance adjustment is applied when the simulation quality changes. See
[volume sampling](../guides/gpu-processing.md#volume-sampling) for the quality/performance tradeoff.
