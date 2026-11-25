---
title: "Splatter"
example: splatter
---

[View live example](https://rzmps.rzmay.com/example/splatter)

# Splatter <ExampleAttribution />

<ExampleTags />

Paint balls should stop being moving objects at contact, while their color stays behind as a mark. This preset
connects each short flight to a long-lived, rough splatter on the struck surface.

<ExamplePreview />

## Throw varied blobs of paint

A small stream receives colors from a discrete palette. Size variation changes both the ball and the inherited
splatter footprint, while a little upward velocity gives gravity room to bend the flight. Random initial roll keeps
the marks from sharing one orientation. Choose Checkerboard or another collision scene so the paint has somewhere to land.

<ExampleCode region="emitters" />

## Replace the ball with evidence of its impact

Collision consumes the ball's remaining lifetime on the first hit. The decal renderer uses that contact to place a
mark and inherit the paint color and scale. The ball therefore disappears at the same place its paint appears,
rather than bouncing away and leaving an unexplained duplicate.

<ExampleCode region="modules" />

## Make the mark look like raised, wet paint

A white splatter image provides the mask so inherited color remains visible. The normal map adds raised detail,
while rough shading keeps the finish matte. Scale inheritance makes a larger ball leave a larger mark. The marks
hold their opacity for most of their long lifetime, then fade rather than vanishing at once. Tune the decal size
relative to the ball when adapting the preset to another surface scale.

<ExampleCode region="renderers" />

For other surface reactions, compare [Fire](./fire.md) or read [Surface Decals](../guides/decals.md).

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />
