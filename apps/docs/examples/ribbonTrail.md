---
title: "Ribbon Trail"
example: ribbonTrail
---

[View live example](https://rzmps.rzmay.com/example/ribbonTrail)

# Ribbon Trail <ExampleAttribution />

<ExampleTags />

Instead of one independent streak behind each particle, this preset connects particles into three moving ribbons.
The goal is a continuous set of strands whose shape comes from the relationship between successive samples.

<ExamplePreview />

## Place enough samples along the ribbon

A torus source sends particles radially outward. The stream is dense relative to the short particle lifetime so
neighboring samples remain close. Motion uses the initial velocity and ordinary system gravity; no extra motion
modules are needed. Increasing speed without increasing emission spreads the samples apart and stretches the strands.

<ExampleCode region="emitters" />

## Connect samples into a readable strand

Ribbon mode groups the particles into three ribbons. A narrow width keeps them distinct, while the eased width envelope
soften their ends. The white-to-cyan gradient gives the length of each strand a direction. A nonmetallic material
keeps the appearance clean. Adjust ribbon count to change the number of strands, then tune width and emission
spacing together rather than treating them as unrelated settings.

<ExampleCode region="renderers" />

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />
