---
title: "Fireworks"
example: fireworks
---

[View live example](https://rzmps.rzmay.com/example/fireworks)

# Fireworks <ExampleAttribution />

<ExampleTags />

A firework should have an anticipation phase, a clear burst and a lingering trail of evidence. This preset separates
the rising rocket, its smoke, and the spark explosion so each can have the right lifetime and appearance.

<ExamplePreview />

## Send up a rocket with a clear launch cue

The root launches colored rockets upward. Its particle lifetime sets when the explosion happens, while the system
loop keeps launches recurring. A discrete palette gives each rocket a coherent color to pass to its sparks. The
rocket has no extra motion modules: launch velocity and gravity establish its flight.

<ExampleCode region="emitters:1" />
<ExampleCode region="renderers:1" />

## Leave smoke behind the climb

Continuous child emission supplies smoke while the rocket is alive. The smoke lives longer, expands and drifts, so
the launch path remains visible after the bright source has passed. Its own lifetime is not truncated by the rocket's
death. Noise and a cubic fade keep the trail soft rather than turning it into another rigid streak.

<ExampleCode region="system:2" />

## Turn the rocket's death into a colored explosion

The death-triggered child emits a radial burst. Inherited color connects it to the launch, while reduced gravity
lets the sparks arc downward more slowly. Animated sprites, short trails and a few lights create distinct bright
points with lingering motion. Artistic renderer children broaden each spark's visible presence. The burst sound
marks the transition from climb to explosion; enable audio in the demo when tuning that moment.

<ExampleCode region="system:3" />

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />

Connect the secondary behavior to the root with the relationships below. The root owns child updates; their
inheritance and event filters decide when each layer starts and which source it follows.

<ExampleCode region="system:connections" />
