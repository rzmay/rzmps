---
title: "Fireworks"
example: fireworks
---

# Fireworks

Chained subsystems, event bursts, audio cues, particle lights, and colorful sprite-sheet fireworks.

[View live example](https://rzmps.rzmay.com/?preset=Fireworks)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

The 2.6-second looping rocket system owns continuous smoke and a death-triggered sparkle system. Rocket lifetime two seconds sets the burst timing. Smoke has a separate 4.5-second particle lifetime; sparkles are nonlooping with reduced gravity modifier 0.18, producing a slower downward arc after the explosion.

<ExampleCode region="system" />

## Emitters

Three rockets per second begin in a radius-one sphere with upward velocity 8.5. A discrete five-color Set gives each launch a clear color. Smoke emits at 36 per second per active context with low alpha 0.1. Each death burst creates 100–300 sparkles at radial speed 4.5–12, spreading the inherited rocket color into a broad shell.

<ExampleCode region="emitters" />

## Modules

The rocket module list is empty, leaving normal integration to shape flight. Smoke uses lateral noise, velocity limits, growth, rotation, and cubic fading. Sparkles fade linearly over their 0.75–1.35-second lifetimes. Child lifetime inheritance is disabled so event particles survive after the rocket dies.

<ExampleCode region="modules" />

## Renderers

Rocket sprites are lit, with launch and death audio selected from two clips and pitch range 0.8–1.2. Smoke uses rough lit alpha sprites. Sparkles use a 5×2 animated atlas at 10 fps with random starting frames, short 0.1-second trails, and up to ten bright lights. The light cap limits a burst’s illumination cost even when hundreds of particles spawn.

<ExampleCode region="renderers" />

