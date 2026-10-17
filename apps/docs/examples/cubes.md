---
title: "Cube Instances"
example: cubes
---

# Cube Instances

Instanced mesh rendering with randomized cube particles and simple lifetime rotation and fade-out.

[View live example](https://rzmps.rzmay.com/?preset=Cube%20Instances)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

A 10-second loop keeps emission continuous, while zero gravity isolates instanced mesh appearance and rotation. Lifetimes of 4–8 seconds leave enough time to watch each cube tumble before it fades away.

<ExampleCode region="system" />

## Emitters

Rate 12 and mean lifetime 6 imply roughly 72 simultaneous cubes. The discrete color Set avoids intermediate hues. Scale ranges from 0.4 to 1, applied to a 0.25-unit box mesh, so visible cube edges stay small enough to separate the instances.

<ExampleCode region="emitters" />

## Modules

Angular velocity is sampled between differently oriented vectors so cubes do not all rotate around the same axis. The cubic fade keeps them opaque early and removes them near death. There is no added acceleration module, so the emitter’s initial motion stays easy to distinguish from rotation.

<ExampleCode region="modules" />

## Renderers

MeshRenderer instances a BoxGeometry and MeshStandardMaterial. Cast and receive shadows are enabled, making real geometric faces apparent when the scene has shadow-casting lights. Compare this example with the sprite-based Spheres preset to see the difference between geometry and spherical normal shading.

<ExampleCode region="renderers" />

