---
title: "Doppler Bullet"
example: dopplerBullet
---

[View live example](https://rzmps.rzmay.com/example/dopplerBullet)

# Doppler Bullet <ExampleAttribution />

<ExampleTags />

This projectile should read as a fast flyby followed by a short wake, with separate evidence left at impacts. The
flash, distortion, sound and surface damage each make a different part of that brief event perceptible.

<ExamplePreview />

## Load the projectile, wake and impact assets

Prepare the bullet template, looping flyby sound, launch sound and damage maps before constructing the layers.
Separate resources let the projectile remain metallic while smoke, distortion and surface marks use their own
appearance. The model and emission-shape helpers remain local to this factory's source file.

<ExampleCode region="system:resources" />

## Establish a fast, straight flight

The root disables gravity and sends a small metallic bullet across the scene. A low launch rate leaves space between
shots. A faint trail shows its path without replacing the projectile's silhouette, while the Doppler sound makes
approach and departure audible. The model, launch direction and scene placement belong to this preset; adapt those
together when changing the firing position.

<ExampleCode region="emitters:1" />

## Mark the surfaces crossed by the projectile

A segment sweep places bullet-hole decals along the traveled path. This preset is piercing: the marks do not stop or
bounce the bullet. The damage material blends its albedo mask, normal and roughness into the surface so a hole reads
as part of that material. A short trail and positional audio reinforce the flight between contacts. Use **UV debug**
for visible receiving surfaces, and enable sound in the live demo to hear the flyby.

<ExampleCode region="renderers:7" />
<ExampleCode region="renderers:1" />

## Leave a wake that can outlive the bullet

Smoke emission follows distance traveled so the path stays spaced along a fast trajectory. Its growth, noise and fade
make it linger briefly instead of moving as a rigid extension of the mesh. A separate heat layer distorts the background
without needing the smoke's color. Their inheritance settings keep a tiny bullet from forcing tiny secondary effects.

<ExampleCode region="system:2" />
<ExampleCode region="system:3" />

## Separate the launch flash from impact dust

The flash and shockwave are spawn bursts: they should happen once at launch, not continuously along the wake. Impact
dust instead selects the registered bullet-hole sources. Sampling the struck surface's color makes that puff look
like wall material rather than projectile smoke. Source filters keep a new hole from replaying the muzzle effects.
Change these timings independently when you want a brighter launch or a more lingering impact.

<ExampleCode region="system:4" />
<ExampleCode region="system:5" />
<ExampleCode region="system:7" />

See [Sources and Events](../guides/emission-sources-events.md) and
[Material Copying](../guides/material-copying.md) for adapting the impact relationship.

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />

Connect the secondary behavior to the root with the relationships below. The root owns child updates; their
inheritance and event filters decide when each layer starts and which source it follows.

<ExampleCode region="system:connections" />
