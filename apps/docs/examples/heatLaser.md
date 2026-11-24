---
title: "Heat Laser"
example: heatLaser
---

[View live example](https://rzmps.rzmay.com/example/heatLaser)

# Heat Laser <ExampleAttribution />

<ExampleTags />

Build a jagged, white-hot beam that appears to burn its way across a surface. Wherever it touches,
sparks and fragments jump away, a glowing mark cools into a dark scorch, and fire gives way to smoke.
The marks keep smoking after the beam moves on; holding the beam still keeps the current spot hot.

<ExamplePreview />

## Decide what the viewer should see

This preset combines several effects because each communicates something different:

| Visual intention | Choice in this preset |
| --- | --- |
| A continuous beam of concentrated energy | Fast particles joined by pale ribbon trails and a wider orange halo |
| An unstable, jagged silhouette | Three strands with independent animated position noise |
| A clear point of contact | Particle collisions shared by the beam, marks and impact subsystems |
| Lasting surface damage | Dark, translucent scorch decals |
| Heat concentrated along the cut | Separate glowing burn decals that overlap along the sweep |
| Material being struck and chipped away | Short spark trails and surface-colored fragment meshes |
| Burns that stay active after contact | Registered decal sources emitting into one shared gas simulation |
| A hot hit point that becomes cooling smoke | Source-age cooling, reheat bursts and temperature-driven volume shading |
| Light falling onto nearby objects | Two warm particle lights, separate from emissive shading |

These are art and interaction choices for this example, not requirements imposed by RZMPS. You can
build the beam first and add the other layers as your effect needs them. The snippets below come from
one self-contained preset, with shared controls, assets and sweep state initialized at the top.

## 1. Make the beam read as continuous energy

Start with two `TrailRenderer`s. The narrow pale core provides the white-hot center, while the broader,
soft orange halo gives it a glow. Additive blending makes their overlapping light accumulate. Keeping
trail width independent of particle scale lets the beam have a visible width while its collision
particles remain small.

Both renderers follow the same particles, so their silhouettes stay together. The halo uses
`Textures.Simple` through the trail's `texture` option; a supplied Three.js material can also use `map`.

<ExampleCode region="renderers:beam" />

The root system launches a dense stream of fast, short-lived particles toward the aim direction.
Joining them into ribbons hides the individual births and makes the stream look like a beam. Gravity
is disabled because this energy should travel straight. World-space simulation leaves existing beam
segments where they were emitted as the aim changes.

The root runs on the CPU so its collision events can directly drive the contact effects. The gas
subsystem added later uses GPU simulation; different parts of this preset deliberately use different
processing modes.

<ExampleCode region="system" />

## 2. Make it jagged without losing the aim

A perfectly straight ribbon looks too clean for the unstable beam we want. Each of its three strands
gets a different noise offset, selected with `core.RibbonCondition(ribbon)`, so the strands do not all
follow the same wiggle. Scrolling the noise keeps the beam moving even when the aim is stationary.

`TransformMode.Position` at transient priority adds visible offsets around the underlying trajectory.
That gives us a jagged outline without accumulating sideways drift into the beam's simulated motion.
The ribbon conditions assume the original particle population; they are not suitable for grouped
particles or renderer children.

<ExampleCode region="modules:beamNoise" />

We also want contact to be consistent: the beam must end where the sparks, fragments and marks appear.
`Collision` kills beam particles on impact and supplies that shared contact event. The small custom
module removes old beam segments beyond a recent hit, preventing a ribbon from hanging in open space
when the aim suddenly moves onto a nearby wall. The hit expires when contact stops, so the beam can
extend into open space again.

<ExampleCode region="modules:beamCollision" />

## 3. Separate surface damage from active heat

One dark decal can suggest damage, but it does not communicate an actively heated surface. We use two
layers: a rough, translucent scorch that remains visible as damage, and a glowing burn that represents
fresh heat. They have independent textures, opacity and deformation, so the damage can stay broad and
subdued while the hot stroke looks brighter and more continuous.

Random rotation breaks up repeated texture stamps. `Warp.FromPoints` then fits each burn between the
last accepted mark and the current hit. Its overlap multiplier extends that fitted length beyond both
ends to join the hot stroke. Scorches use restrained overlap and a lower stretch cap to keep more of
their original shape. Spacing prevents redundant marks at the same location, and lifetime fades let
both layers disappear gradually.

Appearance inheritance is disabled because the beam's tiny collision scale and pale color should not
determine the size or tint of surface damage. Only the glowing burns receive `emissionTags`; those
marks will become the ongoing fire and smoke sources. The scorch layer is purely visual.

<ExampleCode region="renderers:burn" />

### Keep a held hit hot

If the beam stays on one spot, spacing should stop it from adding endless decals. That existing mark
must nevertheless remain hot. The collision listener finds an overlapping burn, restarts its cooling
clock, and sends its source a `reheat` event. We register this listener before attaching the decal
renderers so it can refresh an existing mark before new placement is considered.

Reheating also makes that mark the next sweep anchor. Rejected spacing candidates do not move the
anchor; a newly accepted mark does. Receiver-local source frames keep it attached to a moving object.
Changing receiver, losing contact or switching scenes resets the connection.

`lifetimeHeat` uses cubic easing so a fresh mark loses its strongest heat quickly and spends more of
its lifetime cooling. The same value dims the molten glow. The scorch layer follows its own opacity
fade instead of disappearing as soon as the heat drops.

<ExampleCode region="events" />

The small sweep tracker is application policy: it remembers which accepted or reheated mark should
connect to the next one. The actual deformation remains the built-in `Warp.FromPoints` operation.

<ExampleCode region="helpers:sweep" />

## 4. Sell contact with sparks and fragments

Sparks make an otherwise smooth beam feel forceful. A collision-triggered subsystem throws out short,
bright particles with tiny trails. Their color cools toward red as they fade, and gravity and bounce
make them separate visibly from the beam.

Only a fraction of beam collisions trigger sparks. The beam needs a dense particle stream to draw a
continuous ribbon, but that does not mean every one of those particles needs a full impact burst.
Explicit inheritance keeps the sparks' lifetime, scale and color independent of the beam.

<ExampleCode region="emitters:sparks" />

Fragments add a different cue: the surface appears to be losing small pieces of material. Their mesh
shapes come from the destruction asset, and `MaterialCopy` samples the contacted surface so debris
belongs visually to whatever the laser hits. A smaller collision-trigger ratio keeps this heavier cue
less frequent than sparks.

The fragments bounce, fade, and tumble with speed. Initial angular velocity is zero because we want
`RotationBySpeed` to own the tumble; an independent initial spin would continue after a fragment settles.
The collision radius is sized from the fragment geometry so the visible pieces can land near the surface.

<ExampleCode region="emitters:debris" />

## 5. Let each burn keep emitting after the beam leaves

Fire and smoke should come from the heated marks, not follow the laser origin. Each accepted burn
registers an emission source through `emissionTags: ['laser-burn']`. The gas system's continuous emitter
selects those sources with `sourceTags`, giving every live mark its own plume. Moving receivers carry
the sources with them.

A second emitter listens for `reheat` and adds a short, hotter burst. This makes holding the beam on a
single mark feel active, even though spacing prevents new marks from being added there. These bursts
share the contacted mark's source rather than introducing another kind of impact source.

The gas particles are short-lived contributors to one shared volume, not individually visible flame
sprites. The grid supplies the continuous visible plume, so these source particles can be relatively
sparse. Their scale shrinks and alpha fades to soften their contribution before they die. Source
clocks control the ongoing emission; particle lifetime controls each contributor's brief journey.

<ExampleCode region="emitters:gas" />

### Turn source cooling into cooler, thinner emissions

We want fresh burns to emit strongly, old burns to smoke gently, and expired burns to stop contributing.
The functional `GasModule` applies the source's heat to deposited density and temperature. Reheat
particles receive an extra temperature multiplier so renewed contact has a hotter center.

Both `initialize` and `initializeGPU` express that same choice. The CPU version shows the rule in plain
JavaScript; the GPU version expresses it with nodes over the contributing particles. Cooling changes
new deposition. Gas already in the field continues to flow and dissipate normally.

<ExampleCode region="modules:cooling" />

Fresh heat should also spread more energetically. A particle-initialization module widens radial motion
for hot sources while retaining the upward bias. Cooler sources release a gentler plume. This is an
artistic emission rule separate from the gas solver's buoyancy.

<ExampleCode region="modules:spread" />

### Carry that emission into a rising, fading plume

The shared `GasSimulation` gives the deposited gas buoyancy, turbulence and vorticity, with a slight
leftward drift. Temperature dissipates faster than density so luminous flame can give way to smoke.
Density and transported color use matching dissipation rules so the remaining smoke keeps its intended
color as it fades.

Automatic bounds let burns at different locations contribute to the same domain. The chosen quality
setting keeps a consistent cell width as that domain grows. These solver settings describe the motion
we want; the flame's colors, glow and fine visual breakup belong to the renderer below.

<ExampleCode region="modules:solver" />

## 6. Make hot gas look like flame and cool gas look like smoke

A rising gas field alone could look like ordinary smoke. Temperature-driven color takes it from gray
through orange to a pale hot core. Temperature and density also control emissive shading: hot, dense
flame stays bright under colored scene lights, while cool smoke remains externally lit.

Animated density noise breaks up the volume into less uniform shapes. Its temperature-dependent
strength, contrast and frequency give flame and smoke different detail. Velocity stretching aligns some
of that detail with flow, while its lower hot-temperature multiplier preserves the flame's flickering look.
These are render-time choices; they do not change simulated gas density.

<ExampleCode region="renderers:gas" />

Emissive shading makes the flame itself visible, but does not illuminate nearby surfaces. Two warm
`LightRenderer` lights provide that cue without giving every gas contributor a real scene light.
Their brightness falls with estimated source heat and particle
age, so fresh burns illuminate the scene more than cooling smoke. Grouped lights use a representative
particle's source, making this a deliberate artistic approximation rather than a gas-cell temperature readback.

<ExampleCode region="renderers:lights" />

## 7. Add the interaction and own the result

The controller smooths pointer aim so fast movement draws a connected stroke. Its optional automatic
path pauses, sweeps, revisits an older burn and points toward the floor, showing both ongoing cooling
and reheating without user input. Pointer raycasts choose the aim target; particle collisions still
choose the actual contact.

The preferred **Wall and Sphere** scene supplies simple receivers and an optionally moving sphere.
It is useful for seeing marks and sources stay attached, but the preset can target other scenes too.
Clearing marks when the scene changes prevents old receivers from retaining this effect's sources.

<ExampleCode region="modules:aim" />

The root owns the spark, debris and gas subsystems. Attach it to the scene and update that root once;
its children share its timing. The beam, sparks and debris use CPU simulation, and the gas system
requires native WebGPU. Initialize the renderer before updating. The existing optional `prepare()` call
can allocate and compile GPU resources ahead of the first interaction.

`system.userData.heatLaser` exposes demo controls and `aimAt(point)`. Setting `controls.enabled` to
false stops the beam while existing marks keep cooling. Destroying the root releases its subsystems;
the preset also disposes the textures, materials, fragment geometry and event handlers it owns.

<ExampleCode region="lifecycle" />

To adapt the look, start with beam width and noise for its silhouette, decal overlap and lifetime for
the heated stroke, then source cooling and gas appearance for the flame-to-smoke transition. Those
choices give each layer a clear job rather than making one parameter control the whole effect.

See [decals](../guides/decals.md), [emission sources](../guides/emission-sources-events.md), and
[source-aware GPU initialization](../guides/gpu-processing.md#source-aware-gas-initialization) for the
underlying APIs.
