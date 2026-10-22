---
title: "Fireball"
example: fireball
---

# Fireball

Showcases burst emission, animated sprite growth, particle lights, and inherited heat-distortion particles.

[View live example](https://rzmps.rzmay.com/?preset=Fireball)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

A 1.25-second loop separates repeated explosions. The main sprites live for 0.6 seconds, leaving a quiet gap before the next burst. A spawn-triggered distortion subsystem has independent lifetime and scale, with velocity inheritance 0.5 so the heat wave can partially follow the source particle.

<ExampleCode region="system" />

## Emitters

The main emitter has no continuous rate: five particles burst at time zero from a radius-0.2 sphere. Their 2.5-unit scale overlaps into one explosion. The secondary burst creates five larger distortion particles lasting 0.5 seconds; radial speed 2 spreads their silhouette beyond the visible flame.

<ExampleCode region="emitters" />

## Modules

The main scale multiplier grows from 0.35 to 1.8, making the explosion expand rather than drift. Cubic alpha decay holds brightness until late in life. Secondary upward force and noise stop the heat wave looking like a rigid expanding disc, while its cubic growth and alpha envelope independently remove the distortion.

<ExampleCode region="modules" />

## Renderers

The 5×4 atlas supplies 20 frames at 30 fps, close to the main lifetime. Soft intersections blend the explosion against geometry. Up to 18 particle lights at brightness 5 illuminate the environment briefly. The distortion material uses transmission 1, opacity 0.3, and strength 0.05; its low opacity keeps the background readable.

<ExampleCode region="renderers" />

