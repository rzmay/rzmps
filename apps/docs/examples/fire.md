---
title: "Fire"
example: fire
---

# Fire

Sprite-sheet animation, soft particles, particle lights, and a heat-distortion subsystem.

[View live example](https://rzmps.rzmay.com/?preset=Fire)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

The 10-second loop schedules a continuous flame; individual flame particles last only 1.35 seconds. The shorter particle lifetime keeps the flame near its source while the secondary distortion system supplies a separate one-second heat shimmer. Inheritance is disabled for the shimmer’s appearance so its scale and opacity do not collapse with the flame.

<ExampleCode region="system" />

## Emitters

A cone surface spreads the base of the flame. At 90 particles per second and a 1.35-second lifetime, the main population is roughly 122 sprites before culling. Upward velocity 2.2 and radial speed 0.2 make vertical flow dominate the horizontal spread; the 2.5-unit scale lets adjacent sprites overlap.

<ExampleCode region="emitters" />

## Modules

Noise strength 2.1 and frequency 1.35 break up the regular rise. The additional upward force bends the motion over time, while the scale multiplier shrinks from 1.3 to 0.2. The alpha curve fades in during the first fifth of life and fades out over the final quarter, hiding sprite births and deaths. The distortion subsystem uses gentler noise and its own grow-and-fade curve.

<ExampleCode region="modules" />

## Renderers

The 8×4 atlas contains 32 flame frames played at 24 fps, approximately one animation across the 1.35-second life. Soft-particle distance 1 blends intersections. Particle lights are limited to 18 with ratio 0.3, avoiding a light per sprite. The secondary sprite transmits the background with distortion strength 0.05 and disables depth writing so the shimmer does not occlude the flame.

<ExampleCode region="renderers" />

