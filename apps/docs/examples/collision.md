---
title: "Collision"
example: collision
---

# Collision

Particle collision with automatic mesh detection and sorting between static and dynamic objects for optimizing octree rebuilds. Alternatively Jolt, Rapier, and Ammo can be used as external physics backends, allowing particles to affect other physics objects in the scene.

[View live example](https://rzmps.rzmay.com/?preset=Collision)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

A five-second loop emits particles with eight-second lifetimes under full gravity modifier 1. Long life lets several bounces remain visible. Select a collision scene in the demo or pass a collision scene to the preview command; a neutral empty scene cannot show contacts.

<ExampleCode region="system" />

## Emitters

The radius-0.25 sphere emits 30 particles per second with radial speeds 1–5. At lifetime eight, the population can approach 240 before culling. Mass 1 and uniform scale 0.125 make contact behavior easier to compare, while the orange/yellow range distinguishes particles from collision geometry.

<ExampleCode region="emitters" />

## Modules

Collision uses bounce 0.75 and dampen 0.05, retaining substantial rebound while losing some motion at each contact. radiusScale 1 uses the particle’s normal collision size. applyImpulses true allows compatible external backends to transfer contact impulses to scene bodies; the built-in mesh backend supplies geometric collision queries.

<ExampleCode region="modules" />

## Renderers

Lit Circle sprites use spherical normals and normal lighting 1 to appear round at low geometric cost. Roughness 0.5 softens highlights and castShadow true helps locate particles above scene geometry. Shadows require the scene lights and renderer to enable shadow support.

<ExampleCode region="renderers" />

