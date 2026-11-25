---
title: "LOD Stress Test"
example: lodStress
---

[View live example](https://rzmps.rzmay.com/example/lodStress)

# LOD Stress Test <ExampleAttribution />

<ExampleTags />

This preset makes distance-based density changes easy to see in a busy particle field. Move the camera away and
back while watching the shape and motion, then adjust the LOD settings to suit your own effect.

<ExamplePreview />

## Establish the full-density appearance

A continuous source and multi-second lifetimes form a sustained field. Begin close to it so the unmodified density
is clear. The system's `lod` settings reduce new emission and the surviving population as distance increases.
Approaching again replenishes the field through ordinary emission; a particle that has been removed does not reappear.

<ExampleCode region="system:lod" />
<ExampleCode region="emitters" />

## Keep surviving particles moving smoothly

Velocity and noise give the field enough motion that changes in density remain visible. Scale and opacity envelopes
hide individual births and deaths. LOD changes how many particles exist rather than making survivors move in visible
steps. Tune the visual envelope first, then the distances at which a thinner field still reads as the same effect.

<ExampleCode region="modules" />

## Fill visual gaps at lower density

`CompensationMode.Children` adds visual copies around survivors when system quality falls. Their spacing helps the
field keep a continuous appearance; they inherit their parent's size and opacity. Artistic children are disabled so
this example isolates compensation. Soft particles help the copies meet geometry without sharp intersections.
See [Renderer Children and LOD](../guides/renderer-children-lod.md) for the settings and their visual tradeoffs.

<ExampleCode region="renderers" />

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />
