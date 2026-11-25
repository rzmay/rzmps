---
title: "Smoke"
example: smoke
---

[View live example](https://rzmps.rzmay.com/example/smoke)

# Smoke <ExampleAttribution />

<ExampleTags />

A smoke plume should read as a soft, rising volume rather than a stream of separate cards. This preset builds that
illusion from overlapping sprites, slow buoyancy and a lifetime envelope. Start here before adding a fire source or
changing the material to luminous smoke.

<ExamplePreview />

## Start with a broad, slow source

The cone spreads births across the base of the plume. Upward velocity gives the smoke an initial rise, while a small
negative gravity modifier keeps it buoyant. Modest radial speed lets the base stay together instead of exploding outward.
Large initial sprites overlap; their low opacity lets those overlaps suggest a volume. Shorten the lifetime for a compact
puff, or increase it when the smoke should travel farther before disappearing.

<ExampleCode region="emitters" />

## Let older smoke expand and lose definition

Horizontal noise bends the column into curls, while weaker vertical noise leaves the upward direction readable.
Velocity limits and drag prevent the curls from becoming an accelerating spray. The scale ramp expands each wisp as
it ages. The three opacity timestamps bring it into view, then remove it gradually. Rotation
breaks up repeated texture orientation. Together these choices hide individual births without obscuring the plume's flow.

<ExampleCode region="modules" />

## Give flat sprites a soft, lit silhouette

The smoke image is an alpha mask, not a solid square. Rough lighting and spherical normals give each billboard some
volume under the scene's lights; soft particles blur the line where it meets geometry. Use a lit scene when tuning this
material. For a glowing alternative, compare [Additive Smoke](./additiveSmoke.md): its blending changes the meaning of overlap.

<ExampleCode region="renderers" />

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />
