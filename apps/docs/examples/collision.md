---
title: "Collision"
example: collision
---

[View live example](https://rzmps.rzmay.com/example/collision)

# Collision <ExampleAttribution />

<ExampleTags />

The particles should visibly hit surfaces and rebound, so their source, lifetime and shading make individual contacts
easy to follow. Choose a collision scene in the demo: an empty environment has nothing to bounce against.

<ExamplePreview />

## Launch particles that have time to bounce

Full gravity gives the stream a clear downward arc. Radial launch speeds spread the particles, and long lifetimes let
you watch repeated contacts rather than only the first hit. A consistent small size makes changes to bounce and drag
easy to compare. The warm color range separates the particles from the environment.

<ExampleCode region="emitters" />

## Choose a lively rebound

The Collision module retains much of the incoming motion through a high bounce setting, while light damping removes
some energy on each contact. Lower bounce for heavy or soft material; raise damping when particles should settle.
`applyImpulses` lets a compatible external physics backend push scene bodies. The built-in scene-mesh collision path
still works when you only need particles to react to geometry.

<ExampleCode region="modules" />

## Make contact and height readable

Lit circles with spherical normals look rounded. Shadows help locate each particle relative to the floor, provided
the scene has shadow-enabled lighting. The appearance remains deliberately plain so motion, rather than a texture
animation, explains the contact. For effects triggered by those contacts, continue with [Metal Balls](./collisionSubEmitters.md).

<ExampleCode region="renderers" />

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />
