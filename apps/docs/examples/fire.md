---
title: "Fire"
example: fire
---

[View live example](https://rzmps.rzmay.com/example/fire)

# Fire <ExampleAttribution />

<ExampleTags />

The fire should have a rising flame, a warmer patch of light around it, and heat that continues to disturb the air.
Faint scorch marks let nearby surfaces record the flame's presence. The layers have different jobs and timings.

<ExamplePreview />

## Prepare flame distortion and scorch resources

Load the distortion map and scorch mask once while constructing the effect. The scorch image is color data, so it
uses sRGB color space. Keeping a separate mark material lets the burn's appearance stay independent of the animated
flame sprites. These resources are disposed with the root system.

<ExampleCode region="system:resources" />

## Make the flame rise and break apart

A broad cone, upward velocity and overlapping sprites establish the main silhouette. Short particle lifetimes keep
it near the source instead of letting flame tongues drift far away. Noise interrupts the regular rise; upward force
maintains the overall direction. The scale ramp narrows old flames, and opacity keyframes hide their birth and death.
Start by tuning this layer before adding light or distortion.

<ExampleCode region="emitters:1" />
<ExampleCode region="modules" />

## Put light and accumulated heat into the scene

The animated flame atlas gives each sprite internal motion. Warm particle lights connect the flame to nearby objects.
The scorch renderer casts radial searches around selected flame particles and chooses a random hit among nearby
surfaces. Small, low-opacity marks build a burn gradually rather than stamping one dark patch. Their scale, color and
alpha inheritance are disabled so the marks do not shrink or disappear with the flames. Use Checkerboard to see the
floor darken; adjust scorch opacity separately from flame brightness.

<ExampleCode region="renderers:1" />

## Let the air shimmer on its own timing

A continuous child system draws distortion separately from the flame image. Its growth and fading make the heat
layer disperse, while its own motion keeps it from looking like another flame card. Appearance inheritance is disabled
so flame color and lifetime changes do not collapse the shimmer. Update only the root system; it owns this child.

<ExampleCode region="system:2" />

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />

Connect the secondary behavior to the root with the relationships below. The root owns child updates; their
inheritance and event filters decide when each layer starts and which source it follows.

<ExampleCode region="system:connections" />
