---
title: "Boids"
example: boids
---

# Boids

Flocking particles using ParticleOctree aggregation, with red hazard particles acting as tagged particle affectors.

[View live example](https://rzmps.rzmay.com/?preset=Boids)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

The 24-second loop and lifetimes up to 22 seconds sustain two interacting populations. Gravity is disabled so steering controls their paths. maxParticles 700 bounds the flocking workload; the estimated full-lifetime population can approach that cap as both populations build up.

<ExampleCode region="system" />

## Emitters

The main flock emits 38 particles per second from a radius-12 sphere, while two hazards per second begin on a torus. Tags separate their rules. Main lifetimes 9–16 and hazard lifetimes 14–22 make the hazards persist longer; hazards are also larger (0.65–1.05 versus 0.34–0.48), making pursuit and avoidance visible.

<ExampleCode region="emitters" />

## Modules

Two Boids modules use opposite particle-affector roles: hazards repel boids as obstacles, while boids act as targets for hazards. Main separation weight 2.4 exceeds cohesion 1.35 to resist clumping. Hazard affector weight 5.5 makes target seeking strong. OrientToDirection aligns cone geometry with motion so heading remains readable.

<ExampleCode region="modules" />

## Renderers

Two tag-filtered MeshRenderers use cone meshes and separate materials. Cool flock colors contrast with red/orange hazards, whose material has stronger emissive intensity 0.55. The geometric cone points reveal direction more clearly than a circular billboard would.

<ExampleCode region="renderers" />

