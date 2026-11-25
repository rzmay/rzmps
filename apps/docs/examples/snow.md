---
title: "Snow"
example: snow
---

[View live example](https://rzmps.rzmay.com/example/snow)

# Snow <ExampleAttribution />

<ExampleTags />

Snow should fill a space with small, gently drifting flakes rather than spray out from a point. This preset combines
a wide source, slow falling motion and unobtrusive fades so the snowfall feels continuous.

<ExamplePreview />

## Fill the air above the scene

The system sits above the origin and emits across a broad, shallow box. A small downward velocity and weak gravity
create a slow fall; long lifetimes let flakes cross the scene. Prewarm fills the volume when the effect starts, so it
does not look like a newly opened tap. Keep radial speed at zero to avoid an outward explosion from the source.

<ExampleCode region="emitters" />

## Add drift without losing the fall

Horizontal noise is stronger than vertical noise, creating sideways motion while preserving a downward tendency.
Velocity limits keep the drift gentle, and rotation varies the flake silhouette. Depth fades remove flakes close to
the camera and soften distant ones; the lifetime fade hides normal turnover. Move the camera through the effect to
check those boundaries rather than judging only a stationary view.

<ExampleCode region="modules" />

## Build a field of delicate silhouettes

The snowflake mask supplies the detail. Subtle normal lighting keeps it from looking like a ball. Two artistic
renderer children add nearby visual copies with radial scale and alpha shaping, giving each simulated trajectory a
small cloud of flakes. LOD is disabled here: the children are part of the chosen snowfall appearance. Reduce their
count or radius if your scene needs more isolated flakes.

<ExampleCode region="renderers" />

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />
