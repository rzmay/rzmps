---
title: "Boids"
example: boids
---

[View live example](https://rzmps.rzmay.com/example/boids)

# Boids <ExampleAttribution />

<ExampleTags />

The flock should move together without collapsing into one point, while larger red hazards interrupt its flow.
The two populations have opposing goals, making steering decisions visible through their movement.

<ExamplePreview />

## Prepare the two populations

Start with distinct palettes and emission shapes so the flock and hazards are visually separable before tuning
steering. The sphere gives the flock room to spread; the torus places hazards around it. Keeping these resources
named makes the tagged emitter configuration below easier to follow.

<ExampleCode region="system:resources" />

## Give the flock and hazards distinct roles

A broad sphere source spreads the main flock. Hazards begin around a torus and persist longer, so encounters can
build over time. Tags separate their behaviors; cool flock colors and larger warm-colored hazards distinguish the
roles before motion begins. Gravity is disabled so steering, rather than falling, determines their paths.

<ExampleCode region="emitters" />

## Balance togetherness against personal space

The flock balances alignment, cohesion and separation. Stronger separation resists clumping, while hazard particles
act as obstacles. The hazard population treats the flock as targets instead, creating a visible pursuit-and-avoidance
relationship. Tune one weight at a time: increase separation for a looser flock or reduce attraction for less pursuit.
These are this preset's steering choices, not a universal flocking recipe.

<ExampleCode region="modules" />

## Make direction legible in the silhouette

Tag-filtered cone meshes point along each particle's movement through OrientToDirection. That pointed silhouette
shows heading more clearly than a round billboard. Separate materials and a warmer hazard glow reinforce the roles.
Start with the supplied scene, then adapt the tagged particle-affector arrangement to your own obstacles and targets.

<ExampleCode region="renderers" />

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />
