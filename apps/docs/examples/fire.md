---
title: "Fire"
example: fire
---

# Fire

Sprite-sheet flames, particle lights, heat distortion, and persistent textured scorch marks on nearby surfaces.

[View live example](https://rzmps.rzmay.com/?preset=Fire)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

The 10-second loop schedules a continuous flame; individual flame particles last only 1.35 seconds. The shorter particle lifetime keeps the flame near its source while the secondary distortion system supplies a separate one-second heat shimmer. Inheritance is disabled for the shimmer’s appearance so its scale and opacity do not collapse with the flame. Flame particles continuously project faint scorch marks onto nearby surfaces; use Checkerboard to see the burn build up on a floor.

<ExampleCode region="system" />

## Emitters

A cone surface spreads the base of the flame. At 90 particles per second and a 1.35-second lifetime, the main population is roughly 122 sprites before culling. Upward velocity 2.2 and radial speed 0.2 make vertical flow dominate the horizontal spread; the 2.5-unit scale lets adjacent sprites overlap. The flame particles also supply the scorch renderer with their live positions and rotations. There is no separate scorch emitter or invisible source population.

<ExampleCode region="emitters" />

## Modules

Noise strength 2.1 and frequency 1.35 break up the regular rise. The additional upward force bends the motion over time, while the scale multiplier shrinks from 1.3 to 0.2. The alpha curve fades in during the first fifth of life and fades out over the final quarter, hiding sprite births and deaths. The distortion subsystem uses gentler noise and its own grow-and-fade curve.

<ExampleCode region="modules" />

## Renderers

The 8×4 atlas contains 32 flame frames played at 24 fps, approximately one animation across the 1.35-second life. Soft-particle distance 1 blends intersections. Particle lights are limited to 18 with ratio 0.3, avoiding a light per sprite. The secondary sprite transmits the background with distortion strength 0.05 and disables depth writing so the shimmer does not occlude the flame. DecalRenderer disables spawn placement and uses continuousRate 1.5, so each surviving flame particle projects after each two-thirds of a second of particle age. Twenty-four spherical directions find the nearest surface within three world units. The supplied black scorch texture uses a 2.5-unit footprint and shallow 0.06-unit clipping depth. Each mark lives eight seconds, fades in over its first 0.08 seconds, and fades out over its final 3.2 seconds. Peak opacity is just 0.035, so overlapping marks from multiple flame particles gradually darken the surface. Color, scale, and alpha inheritance are disabled so flame tint and lifetime modifiers do not change the burn marks. The factory disposes its scorch template material and texture when destroyed.

<ExampleCode region="renderers" />

