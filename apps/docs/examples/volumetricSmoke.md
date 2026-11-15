---
title: "Volumetric Smoke"
example: volumetricSmoke
---

[View live example](https://rzmps.rzmay.com/example/volumetricSmoke)

# Volumetric Smoke <ExampleAttribution />

<ExampleTags />

The initial Gas Volume preset's rolling flow, with a uniform warm-gray color and a very mild reddish tint.

<ExamplePreview />

## Particle System Configuration

This native WebGPU preset continuously emits through a repeating ten-second loop. Its solver,
emission and motion settings follow the earlier Gas Volume example, before the fire redesign.
The domain initially reserves 16 local units per side. Directional automatic padding and delayed
shrinking keep the domain aligned with source motion and existing smoke support.

<ExampleCode region="system" />

## Emitters

White source particles continuously leave a small sphere with radial and upward velocity.
Short lifetimes and shrinking sizes keep the source compact; the Eulerian field retains smoke after
each particle expires. There is no pulsed emission gate. The renderer supplies the warm-gray tint.

<ExampleCode region="emitters" />

## Modules

Density/color, temperature and velocity dissipate independently. Buoyancy lifts warm gas, scalar
diffusion spreads concentration, turbulence noise adds motion, and vorticity confinement preserves
rolling detail. Temperature emission cools over particle lifetime. Turbulence settings use the
`turbulenceNoiseStrength`, `turbulenceNoiseFrequency`, `turbulenceNoiseSpeed` and `turbulenceNoiseOctaves` names.

The original upward lifetime force, particle noise motion, shrinking source sizes and lifetime alpha
fade are restored too. ColorOverLifetime changes only alpha; it no longer cycles source colors.
Source collision retains lifetime loss one and the grid discovers fluid colliders automatically.

<ExampleCode region="modules" />

## Renderers

The renderer's warm-gray `color` multiplies transported particle color; white particles preserve this
tint. The `densityNoiseStrength`, `densityNoiseContrast`, `densityNoiseFrequency` and `densityNoiseSpeed`
settings supply visual breakup independently of simulated turbulence. Two samples per voxel and a
256-step limit resolve masked detail without intentionally changing opacity.

There is no temperature-driven tint or lifetime color gradient. Simulation lighting/shadows can vary
brightness, while the transported smoke keeps its single slightly reddish gray hue.
`lightingGridOptions` enables managed lighting with 0.25-unit probes, twelve finest directions,
eight interval samples and a fixed sixteen-unit lighting distance. Moving scene lights,
new lights entering range and HDRI changes refresh lighting even when particle simulation is paused.

<ExampleCode region="renderers" />

The demo uses three brick subdivisions and three cell subdivisions for its realtime performance budget.
`minVolumeQuality: 8` starts it at a 0.125-unit cell width rather than oversampling its compact initial
domain. Larger smoke support can still request a coarser automatic tier.
