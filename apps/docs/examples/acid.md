---
title: "Acid"
example: acid
---

[View live example](https://rzmps.rzmay.com/example/acid)

# Acid <ExampleAttribution />

<ExampleTags />

The acid should leave active pools, not just a splash that disappears. Falling droplets create surface marks; each
pool continues to give off smoke and occasional bubbles after the droplet is gone. Choose Checkerboard for a floor.

<ExamplePreview />

## Make droplets leave a lasting source

The root emits slowly so individual pools have room to develop. Collision ends the airborne droplet, while the decal
renderer leaves its green footprint on the hit surface. Registering that footprint as a tagged source gives the smoke
and bubbles a stable place to begin. Only those pool sources are selected for the secondary effects, so airborne
droplets do not smoke or bubble before landing.

<ExampleCode region="emitters:pool" />
<ExampleCode region="modules:pool" />

## Give the surface a wet, fading footprint

The pool material and opacity curve make the acid read as a surface layer rather than another floating particle.
Its lifetime controls how long that source remains active. Child particles have independent lifetimes, allowing an
existing wisp or bubble to finish naturally when a pool fades. Keep the pool's scale separate from the original
droplet when changing the footprint.

<ExampleCode region="renderers:materials" />
<ExampleCode region="renderers:pool" />

## Let smoke rise and bubbles arrive in episodes

Smoke emits continuously from local offsets across the pool. Growth, slow rotation and noise make the wisps spread.
Bubbles arrive on separate per-pool countdowns rather than as a constant stream, giving the surface a quieter interval
between reactions. A short bubble-growth ramp makes each one form before drifting away. Refractive bubble materials
and their own reflections suggest a thin shell. Increase the countdown gaps for calmer acid, or the smoke rate for
a more active, vaporous pool. See [Sources and Events](../guides/emission-sources-events.md) for source selection.

<ExampleCode region="emitters:1" />
<ExampleCode region="modules:1" />

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />

Connect the secondary behavior to the root with the relationships below. The root owns child updates; their
inheritance and event filters decide when each layer starts and which source it follows.

<ExampleCode region="system:connections" />
