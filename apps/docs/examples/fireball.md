---
title: "Fireball"
example: fireball
---

[View live example](https://rzmps.rzmay.com/example/fireball)

# Fireball <ExampleAttribution />

<ExampleTags />

This effect should read as a brief expanding explosion, followed by disturbed air and a visible trace on nearby
surfaces. A quiet gap between bursts keeps the timing clear.

<ExamplePreview />

## Prepare the heat and scorch resources

Load the distortion map and scorch mask before creating the burst. The mark material is separate from the animated
fireball so it can stay fixed on a surface after the flame has faded. This setup is shared by repeated bursts of the
same system; it does not reload textures for every particle.

<ExampleCode region="system:resources" />

## Build one overlapping burst

The main emitter uses a time-zero burst rather than continuous emission. Several large sprites overlap into one
fireball. Their short lifetimes leave room before the next system loop; scale growth expands the silhouette while
the cubic alpha fade removes the flame late in its life. Tune burst count and starting size together before widening
the source, otherwise the explosion can break into unrelated small puffs.

<ExampleCode region="emitters:1" />
<ExampleCode region="modules:1" />

## Make the flash affect its surroundings

The animated atlas supplies rapid internal flame motion, and particle lights illuminate nearby geometry. Radial
scorch searches choose nearby hits while the burst is alive. The marks have their own fixed footprint and slow fade,
so they remain after the flame disappears. Low opacity lets repeated bursts accumulate damage gently. Choose a scene
with nearby surfaces to see this layer; the empty background cannot receive decals.

<ExampleCode region="renderers:1" />

## Follow the flash with a heat wave

A spawn-triggered child burst supplies larger distortion particles on a separate lifetime. Partial velocity inheritance
connects the wave to the source without forcing it to copy the whole flame motion. Noise, growth and an opacity
envelope soften the expanding shape. Keep this layer subtle enough that the background remains readable through it.

<ExampleCode region="system:2" />

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />

Connect the secondary behavior to the root with the relationships below. The root owns child updates; their
inheritance and event filters decide when each layer starts and which source it follows.

<ExampleCode region="system:connections" />
