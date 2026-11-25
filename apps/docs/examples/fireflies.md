---
title: "Fireflies"
example: fireflies
---

[View live example](https://rzmps.rzmay.com/example/fireflies)

# Fireflies <ExampleAttribution />

<ExampleTags />

Fireflies should form small groups of responding flashes rather than one synchronized blinking field. Each insect
charges toward a flash; nearby flashes can bring it closer to that threshold, and a rest period separates its pulses.

<ExamplePreview />

## Give the insects room to form groups

An initial burst fills a broad, shallow volume. Gentle noise and a speed limit keep them drifting instead of flying
outward from a single point. The main sprite shows the insect even between flashes. Keep the volume spacious relative
to the neighbor radius if you want some insects to flash alone and others to gather into loose clusters.

<ExampleCode region="system:settings" />
<ExampleCode region="emitters:1" />
<ExampleCode region="renderers:1" />

## Let a nearby flash influence the next one

The custom flash module uses a charge value and a cooldown. Only sufficiently charged insects respond to neighbors,
so a passing flash can advance a pulse without making every insect react instantly. This preset uses particle mass
as its own charge accumulator because no physical force here needs mass. That is an example-specific choice, not a
requirement for custom events. A separate glow population keeps the visible pulse independent of the insect's lifetime.

<ExampleCode region="modules:1" />

## Keep each glow attached and local

Source simulation space attaches a glow to the insect that triggered it. `SourceLossBehavior.Kill` removes the glow
if that insect disappears. A smooth periodic envelope shapes opacity and light brightness together. Small additive
sprites and short-range yellow-green lights keep the pulse local. Use Checkerboard with lower scene light strength
to see the glow on the floor. For event and attachment details, see [Sources and Events](../guides/emission-sources-events.md).

<ExampleCode region="system:glow" />

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />

Connect the secondary behavior to the root with the relationships below. The root owns child updates; their
inheritance and event filters decide when each layer starts and which source it follows.

<ExampleCode region="system:connections" />
