---
title: "Stylized Depth"
example: stylizedDepth
---

[View live example](https://rzmps.rzmay.com/example/stylizedDepth)

# Stylized Depth <ExampleAttribution />

<ExampleTags />

This effect uses camera depth as an art direction tool: particles change color, size and motion as they move through
the view. It is meant to make depth readable through deliberate styling rather than only ordinary perspective.

<ExamplePreview />

## Populate several depths at once

A broad box source and prewarm put particles at different depths immediately. Gravity is disabled so a falling arc
does not compete with the depth-dependent motion. Slow initial drift gives you time to compare nearby and distant
particles. The system's offset places the volume in front of the initial camera.

<ExampleCode region="emitters" />

## Make distance change the visual language

The modules share a depth range, so their changes feel coordinated. Farther particles shift toward cyan, become more
transparent and receive different size and movement treatment. These responses follow camera depth, not particle age:
move the camera to understand the distinction. Keep one shared range while tuning, then separate ranges only when
a particular layer should change sooner than the others.

<ExampleCode region="modules" />

## Give depth styling control of size and color

Unlit circular sprites keep the palette independent of scene lighting. Disabling ordinary size attenuation lets the
explicit depth scale define the intended apparent size. Re-enable it for a more natural perspective effect, or keep
this arrangement when you want graphic, screen-oriented particles.

<ExampleCode region="renderers" />

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />
