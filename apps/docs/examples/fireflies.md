---
title: "Fireflies"
example: fireflies
---

# Fireflies

Drifting fireflies respond to neighboring flashes with native events, attached glow pulses, and small lights.

[View live example](https://rzmps.rzmay.com/?preset=Fireflies)

<ExampleAttribution />
<ExamplePreview />

## Particle System Configuration

An initial burst of 64 fireflies drifts through a 24 × 6 × 16 box, with sprites sized at 0.22.
Each accumulates charge, and nearby flashing neighbors accelerate
its approach to a threshold. Crossing the threshold emits a custom flash event, resets charge, and starts a 1.4-second
refractory period. This condition depends on the surrounding population rather than spawn, death, collision, or age
alone. The larger, sparse volume and local radius allow separate flash clusters and isolated insects instead of one
pulse immediately synchronizing the whole population.

The event creates one 0.65-second glow particle. Its strength controls glow size; its source identity keeps the glow
attached to the moving firefly through Source simulation space. GPU processing uses a slot and generation pair,
rejecting a dead or reused source slot. Both systems remain owned and updated by the root.

<ExampleCode region="system" />

## Emitters

A box volume distributes the insects across the scene, with randomized initial charge to stagger their first pulses.
Eight new insects per second quickly replenish deaths, with the live population capped at 96. Insects live for
24–32 seconds unless they leave the larger kill volume first. A single point-source burst emits each glow, so the event
has a visible purpose without adding decorative sparks or a permanent trail. Its `radialSpeed` is explicitly zero:
Source space carries independent particle motion with the source, so the emitter's default speed of 1 would make a
pulse drift away from the insect.

<ExampleCode region="emitters" />

## Modules

Low-frequency noise supplies smooth motion, with stronger forces and a 1.3-unit-per-second limit on each velocity axis.
Drag damps the motion without steering insects back toward the box. A boundary module calls particle.kill() when an
insect leaves a separate 44 × 14 × 32 kill volume. This adds margins of 10 units on X, 4 on Y, and 8 on Z around
the spawn box, allowing substantial free flight before recycling. Both spatial query structures cover this larger
volume. GPU grid auto-expansion is disabled;
dead particles are excluded from its rebuild. The flash module queries a managed CPU octree or
GPU spatial grid within radius 2.25, excluding the querying firefly. Only sufficiently charged insects respond to nearby
flashes, and the cooldown prevents continuous retriggering.

The example uses mass as an application-owned charge accumulator because no physical forces depend on mass here.
Negative charge represents the refractory period; its first 0.65 seconds signal a visible flash to neighbors.
The CPU event carries an object containing strength. The GPU event packs strength into the first component of one vec4;
the GPU handler consumes strength. Source space handles source identity automatically, leaving the other payload
components available to applications that need more metadata.

The glow system uses `simulationSpace: 'source'` to keep its small sampled offset attached to the moving insect.
`sourceLoss: 'kill'` removes a pulse when its insect dies. It needs no follow module, source maps, or scratch identity
attributes. ColorOverLifetime supplies the smooth sine opacity pulse. No per-particle tag changes are needed because
the glow population is separate from the insects.

<ExampleCode region="modules" />

## Renderers

The supplied firefly PNG displays the insects. Soft additive sprites display pulses, while a LightRenderer attached
only to the glow system selects a quarter of the pulses and supplies at most sixteen small yellow-green point lights.
This also makes its bounded GPU sample cover the glow system's 128 slots, including sparse active slots. The small
0.38-size glow sprites and 1.1-unit light range keep each pulse local. The brightness callback evaluates the same sine
pulse envelope with peak intensity 0.52. It evaluates the curve explicitly because GPU light readback uses stored
simulation state, while ColorOverLifetime applies opacity during the transient render phase.

The particle factory adds no scene geometry. Select Checkerboard and lower **Scene Settings → Light Strength**
to about 0.08 to see the insects and local light patches against a dim floor. This control scales the scene's ambient
and point lights together, leaving particle lights independent. The default value of 1 preserves normal scene lighting.

On WebGPU, insect simulation, neighbor queries, custom event consumption, and glow simulation remain native.
The LightRenderer uses bounded selective particle readback to position Three.js lights; it does not read the custom
event buffer. Disabling that renderer leaves the particle effect and event processing entirely on the GPU.

<ExampleCode region="renderers" />

See [Sources and Events](../guides/emission-sources-events.md) for event payloads and readback semantics,
[Particle Spatial Acceleration](../guides/particle-octree.md) for neighbor queries, and
[Using Tags](../guides/tags.md) for optional GPU tag mutation helpers.

See [Simulation frames](../guides/subsystems.md#simulation-frames) for attachment and source-loss behavior.
