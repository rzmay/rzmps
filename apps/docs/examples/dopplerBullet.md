---
title: "Doppler Bullet"
example: dopplerBullet
---

# Doppler Bullet

Doppler effect on a fast bullet particle, with smoke, faint trails, spawn blast effects, and distortion wake subsystems.

[View live example](https://rzmps.rzmay.com/?preset=Doppler%20Bullet)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

The root loops over 5.5 seconds, caps at eight particles, and disables gravity for nearly straight flight. Four subsystems provide smoke wake, heat wake, muzzle flash, and spawn shockwave. Their inheritance factors are zeroed so the small fast bullet does not force every secondary effect to copy its scale or velocity.

<ExampleCode region="system" />

## Emitters

The bullet emits at rate 0.9 with lifetime 1.9 seconds and z velocity from -31 to -36. Its source cone is placed near z=34, giving it a long path across the scene. Smoke uses rateOverDistance 5, maintaining wake spacing as the bullet moves; flash and shockwave use time-zero bursts rather than continuous emission.

<ExampleCode region="emitters" />

## Modules

The root has no explicit module list. Secondary smoke uses force, noise, growth, rotation, and a fade envelope. Heat and shockwave systems grow while distortion fades; flash color shifts from pale yellow to orange. These separate timing curves keep the initial flash brief while the slower wake remains visible.

<ExampleCode region="modules" />

## Renderers

The metallic mesh is paired with a faint 0.28-second trail of width 0.055 and opacity 0.22. AudioRenderer uses dopplerEffect 2.4, speed/depth volume response, and pitch variation to emphasize a fast flyby. The 5×4 flash atlas plays at 36 fps, while non-billboard, double-sided distortion sprites show the shockwave from either side.

<ExampleCode region="renderers" />

