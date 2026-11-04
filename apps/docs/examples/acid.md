---
title: "Acid"
example: acid
---

# Acid

Green acid pools emit rotating smoke and floating refractive bubbles. Select Checkerboard for a floor.

[View live example](https://rzmps.rzmay.com/?preset=Acid)

<ExampleAttribution />
<ExamplePreview />

## Particle System Configuration

This factory reuses Splatter's droplet collisions, surface projection, lighting, textures, and disposal. The droplet
rate is 0.3 per second. Pools last eighteen seconds and have twice the previous width and height. The pool keeps its
registered emission source after its original droplet dies. Each source disappears with its decal, while previously
emitted smoke and splash particles finish their own lifetimes. Update only the root system.

<ExampleCode region="system" />

## Emitters

Smoke uses five particles per second per pool with alpha 0.13. Its rotation and scale match the Smoke example:
initial size 2.5, a lifetime scale multiplier growing from 0.35 to 1.8, and angular velocity sampled between -1 and 1
radians per second. Billboard sprites use rotation X for screen-space roll. A flattened radius-0.45 sphere supplies
random local offsets across the pool before the source transform is applied. Noise, expansion, subtle rotation and
a sine opacity envelope create varied wisps. Bubble events create six
pastel green bubbles with 4–7 second lifetimes,
slow upward velocity and gentle buoyancy. Event strength scales their size and adds a small upward drift. The smoke and
bubble systems use the same emitter contexts on CPU; GPU children receive batched births allocated into actual free GPU
slots.

<ExampleCode region="emitters" />

## Modules

PoolBubbling uses `Module.prepare(context)` as a once-per-simulation-step hook, including GPU processing. Its
per-particle
`modify` and `modifyGPU` callbacks intentionally do nothing; the empty GPU callback preserves GPU eligibility. The
factory returns a ParticleSystem rather than its own animation loop, so prepare() keeps the scheduler on the system's
clock, respecting pause, simulation speed and fixed-step advancement. Call `super.prepare(context)` when overriding it.

This is also a useful pattern for other effect-level scheduling. In an application that owns the animation loop, the
same scheduling code can run outside a module before calling the root system's update(). Do not update children
separately.

Independent countdowns follow decal source IDs: each pool waits 2–4 seconds before its first burst, then 7–11 seconds
between subsequent bursts. The longer gaps distinguish bubbling events from continuous smoke. Expiry removes timer
state, and ordinary source updates do not restart countdowns. No interval callbacks or hidden particles keep pools
alive.

<ExampleCode region="modules" />

## Renderers

The reused DecalRenderer publishes acid-pool tags. Both children select that tag, excluding the airborne parent
droplets. Smoke continuously follows each pool; bubbles subscribe to bubble events. Alpha inherits the fading decal
opacity, so emissions soften near expiry. Full transform-scale inheritance spreads emission across each pool's
footprint. The emitter shape defines local offsets, then the registered source transform places and scales them.
Lifetime inheritance is zero because pools are persistent external sources with independent child lifetimes.

Bubbles copy the Bubbles preset's lit material settings: spherical normals 1, roughness 0.15,
metalness 0.5, normal lighting 0.75, transmission 0.7 with the simple texture, and normal-map
refraction distortion -0.05. Size-driven distortion and a gentle wobble soften their movement.
The bubble subsystem owns a live cubemap; normal root updates refresh subsystem cubemaps too.
The factory disposes both bubble material textures with the root.

<ExampleCode region="renderers" />

See [Sources and Events](../guides/emission-sources-events.md), [Surface Decals](../guides/decals.md), and
[Fireflies](./fireflies.md) for neighbor-triggered GPU light pulses.
