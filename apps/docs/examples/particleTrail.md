---
title: "Particle Trail"
example: particleTrail
---

[View live example](https://rzmps.rzmay.com/example/particleTrail)

# Particle Trail <ExampleAttribution />

<ExampleTags />

The visible effect is the path left behind a moving particle. Each source follows an arcing, disturbed trajectory;
its trail gives that brief motion enough persistence to read as a streak.

<ExamplePreview />

## Launch a few distinct paths

A compact source starts particles upward with varied lateral velocity. Downward gravity bends those launches into
arcs. Only a modest stream is needed because a trail occupies the path, not just its current endpoint. Keep the
launches separate enough to follow one before increasing their overlap.

<ExampleCode region="emitters" />

## Disturb the path sideways

Noise acts strongly across the horizontal plane while leaving the launch height mostly to velocity and gravity.
That choice produces erratic lateral motion instead of a smooth fountain. The strength is intentionally pronounced;
reduce it when adapting the effect to a calmer wake or a smaller scene.

<ExampleCode region="modules" />

## Let the path linger and taper

Particle mode gives each source its own trail. Its lifetime controls how much past motion remains visible, while
minimum vertex distance controls how closely the path is sampled. An eased width envelope tapers the beginning and end so
the streak does not end as a blunt strip. A cyan-to-pink gradient makes progression along the trail clear.
`dieWithParticles: false` lets the remaining segments finish after their source disappears.

<ExampleCode region="renderers" />

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />
