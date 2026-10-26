---
title: "Spheres"
example: spheres
---

# Spheres

Lit sprite particles with spherical normals for a 3D effect.

[View live example](https://rzmps.rzmay.com/?preset=Spheres)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

This 10-second looping system has zero gravity and no gravity modifier, so the particles show simple outward movement without falling. Lifetimes of 6–12 seconds keep particles visible long enough to inspect the lighting illusion as they spread.

<ExampleCode region="system" />

## Emitters

Rate 12 and mean lifetime 9 imply roughly 108 live particles before culling. A discrete four-color Set keeps recognizable red, green, yellow, and blue groups. Scale varies from 0.1 to 0.25 so the field has depth and size variation without a few large particles dominating.

<ExampleCode region="emitters" />

## Modules

The module collection is explicitly empty. Position changes come from the emitter’s initial velocity and system integration. Color, alpha, and size remain at their initial values, making this a useful baseline for checking the renderer before adding lifetime modifiers.

<ExampleCode region="modules" />

## Renderers

A Circle sprite with lit material, spherical normals 1, and normal lighting 1 simulates rounded lighting on a flat billboard. Roughness 0.5 provides a softer surface response. The particles look volumetric without the vertex cost of one sphere mesh per particle.

<ExampleCode region="renderers" />

