---
title: "Suzanne Instances"
example: suzanneInstances
---

# Suzanne Instances

Mesh instancing with Suzanne particles and randomized transforms.

[View live example](https://rzmps.rzmay.com/?preset=Suzanne%20Instances)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

The 10-second loop and zero gravity keep the instanced models floating. GLTF geometry is cloned once and shared by the renderer. The existing rotateX(-90) call uses radians, so inspect the current orientation in a preview if changing the imported model.

<ExampleCode region="system" />

## Emitters

Rate 12, lifetimes 4–8 seconds, and scale 0.4–1 produce a manageable group of roughly 72 instances at average lifetime. Alignment 1 orients particles to emission direction. A four-color Set varies the instances without constructing a separate material for each particle.

<ExampleCode region="emitters" />

## Modules

The sole ColorOverLifetime module applies a cubic alpha fade. It leaves scale and trajectory alone so the recognizable mesh silhouette and directional alignment carry the effect. Most of each lifetime remains visible before the late fade removes the instance.

<ExampleCode region="modules" />

## Renderers

MeshRenderer shares the loaded Suzanne geometry with a MeshStandardMaterial and enables cast/receive shadows. Unlike the Suzanne surface-emission example, every particle represents a full model. Watch geometry cost and draw workload when increasing the population.

<ExampleCode region="renderers" />

