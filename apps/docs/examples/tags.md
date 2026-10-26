---
title: "Cubes and Spheres"
example: tags
---

# Cubes and Spheres

Tag-based module and renderer filtering by mixing cubes and spheres in one particle system.

[View live example](https://rzmps.rzmay.com/?preset=Cubes%20and%20Spheres)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

The 10-second loop shares emission and zero-gravity integration between cubes and spheres. This demonstrates how one system can own several appearances without maintaining two independent simulations. Lifetimes 6–12 seconds leave time to compare the tagged behaviors.

<ExampleCode region="system" />

## Emitters

The emitter assigns spheres and cubes with tagSelection distribute, alternating groups instead of giving every particle both tags. Rate 12 means roughly six per second in each group. Scale 0.1–0.25 and a discrete four-color Set vary appearance while keeping particle motion comparable.

<ExampleCode region="emitters" />

## Modules

Only cubes receive rotation and cubic alpha fade. Only spheres receive growth from multiplier 0.35 to 1.8 and a Collision module. Matching tags on each module prevents accidental cross-group changes. Add collision scene geometry to see the sphere-only contact response.

<ExampleCode region="modules" />

## Renderers

The sphere renderer filters to spheres and uses a lit Circle sprite with spherical normals. The cube renderer filters to cubes and instances BoxGeometry with MeshStandardMaterial. Both enable shadow casting, and cubes also receive shadows. Distributed tags avoid drawing both a mesh and a sprite for every particle.

<ExampleCode region="renderers" />

