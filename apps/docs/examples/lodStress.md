---
title: "LOD Stress Test"
example: lodStress
---

# LOD Stress Test

Emitter and renderer LOD controls under a dense particle load.

[View live example](https://rzmps.rzmay.com/?preset=LOD%20Stress%20Test)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

The system caps population at 50000, loops over 10 seconds, and disables gravity. This is a stress example: the cap protects against unbounded accumulation while emission and rendering LOD can reduce the actual population and visible count at distance.

<ExampleCode region="system" />

## Emitters

Rate 1800 with lifetime 2.5–5 would sustain roughly 6750 particles at full emission before culling. Small scale 0.08 avoids filling the screen with giant billboards. Shared countLOD starts at distance 10 with quality 0.7 and up to five levels, reducing emission workload as the camera moves away.

<ExampleCode region="emitters" />

## Modules

Velocity and noise use update LOD at distance 10 with quality 0.5 and one level, reducing those module updates away from the camera. Scale and alpha lifetime curves remain present to hide abrupt births and deaths. Noise strength 2.5 and frequency 2.2 make skipped motion updates visible when inspecting quality tradeoffs.

<ExampleCode region="modules" />

## Renderers

The lit Circle sprite renderer uses the same countLOD settings as the emitter. compensateSize true enlarges retained sprites to recover some coverage when fewer are drawn. This trades individual particle fidelity for apparent density. Soft-particle distance 1 reduces geometric intersections during camera movement.

<ExampleCode region="renderers" />

