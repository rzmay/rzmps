---
title: "Ribbon Trail"
example: ribbonTrail
---

# Ribbon Trail

Ribbon trail rendering for continuous streaks with lifetime fading.

[View live example](https://rzmps.rzmay.com/?preset=Ribbon%20Trail)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

The 4-second loop supplies a continuous ribbon field. Each particle lasts one second, so its contribution remains near the current emitter rather than accumulating indefinitely. No gravity override is supplied; the system’s default gravity behavior still applies.

<ExampleCode region="system" />

## Emitters

The torus source emits 50 particles per second with radial speed 5. A short one-second lifetime and scale 0.12 produce many closely spaced samples around the source. Increasing speed without increasing emission rate would separate those samples and visibly change the ribbon shape.

<ExampleCode region="emitters" />

## Modules

No module array is supplied here; the system therefore uses its empty module default. The system configuration shown below is the actual source for that absence. Motion comes from initial radial velocity and default system integration, while width and color variation are handled by the trail renderer.

<ExampleCode region="modules" />

## Renderers

Ribbon mode connects particles into three ribbons rather than assigning an independent trail to each particle. Ratio 1 includes all samples and width 0.15 keeps the strands narrow. The width envelope tapers both ends and the white-to-cyan gradient distinguishes the length of the ribbon. Roughness and metalness zero create a clean nonmetallic surface response.

<ExampleCode region="renderers" />

