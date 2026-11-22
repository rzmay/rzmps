---
title: "FLIP Fluid"
example: flipFluid
---

[View live example](https://rzmps.rzmay.com/example/flipFluid)

# FLIP Fluid <ExampleAttribution />

<ExampleTags />

A pouring liquid with a reconstructed water surface, ballistic spray and surface-attached foam.

<ExamplePreview />

## Particle System Configuration

This GPU-only preset needs an initialized native WebGPU renderer. The parent system owns the FLIP
solver, surface renderer and secondary systems; update the parent once per frame. Its 32,000-particle
limit and thirty-second marker lifetimes allow liquid to accumulate while the emitter keeps running.
Gravity is 5.2 local units/second² downward. The named spray and foam systems have independent lifetimes
and particle limits; renderer children add visual foam without adding simulated liquid markers.

The direct example route and documentation preview use the **Fluid Teapot** scene. Its lidless mesh is
the automatically collected collider. The scene's **Tip** control pours the vessel; automatic tipping
can be disabled in Scene Settings. Switching particle presets in an already selected scene preserves
that scene, so the solver also works with other scenes' automatically collected geometry.

<ExampleCode region="system:1" />

## Emitters

A small sphere emits 450 markers per second with 0.085-unit scale, blue color and a gentle downward
initial velocity. Low radial speed keeps the inlet narrow. Marker scale participates in the solver's
rest-spacing model as well as surface support; changing it affects packing, not just display size.
The teapot scene positions the source above the opening while the container tips beneath it.

<ExampleCode region="emitters:1" />

## Modules

`FLIPSimulation` collects scene colliders through `collisionOptions`, using the same membership
settings as the Three.js collision backends. The occupancy bake is 96 texels wide to preserve the
teapot's narrow spout. Bulk markers use the fluid solver's collision path; there is no separate
`Collision` module competing with it on the parent system.

The solver uses 28 pressure iterations, PIC blending of 0.08, four collision iterations, separation
strength 0.5 and spacing multiplier 1.1. These settings retain fluid motion while correcting marker
compression. `maxVelocity: 6` bounds numerical excursions; it is not an emission speed setting.

The spatial index uses three brick subdivisions and four cell subdivisions. Automatic padding grows
the physical domain around the liquid independently of quality changes. `spatialGridOptions.maxBounds: 10`
limits its extent; `FluidBoundsPolicy.Kill` removes markers that leave the explicit cap, rather than
killing markers at ordinary intermediate growth edges. Renderer reconstruction has its own grid and
quality controls below; raising one does not automatically raise the other.

<ExampleCode region="modules:1" />

## Renderers

`SurfaceRenderer` reconstructs a mesh from the markers instead of drawing individual liquid sprites.
Its 0.0625-unit voxel size, anisotropic support and light field/mesh smoothing balance small streams
against a stable surface. The GUI's **Extraction** control switches between the built-in Surface Nets
and Marching Cubes methods. Reconstruction quality changes geometric detail, not pressure quality.

`SurfaceRenderer.LiquidMaterial` supplies transmission, a water-like index of refraction of 1.333,
and pale-blue attenuation. The transported blue particle color contributes through mesh vertex colors.
The material's `flow` settings vary color, roughness and normal detail with reconstructed surface
activity. `deformationRange` and `vorticityRange` normalize strain and curl; uniform translation alone
does not create foam-like shading. `flow.noiseSpeed` controls normal-noise animation and is editable
under **Material → Flow**. Material settings can change without rebuilding the liquid solver.

<ExampleCode region="renderers:surface" />

## Spray

`FLIPSimulation.SprayCondition` supplies the subsystem's `shouldEmitGPU` predicate. It selects moving,
partly isolated parent markers using age, speed and neighborhood support. This is an emission selector,
not a second liquid solver. The child inherits initial velocity but supplies its own scale, lifetime,
color and alpha. It shrinks, fades in/out and dies on collision. Additive soft sprites use the existing
spray alpha-map texture so droplets blend with the water and opaque geometry.

<ExampleCode region="spray" />

## Attached foam

`FLIPSimulation.FoamCondition` uses `minimumDeformity: 0.5` and the surface renderer's GPU sampler to
select active free-surface sources. An additional world-space normal test excludes downward-facing
surfaces. `SurfaceAttachment` keeps foam near the same reconstructed liquid surface and inherits its
motion; detached particles die. These particles use bubble-style lit sprites with existing transmission
and distortion textures. Distortion scales with particle size, and renderer children fill out clusters
without increasing simulation counts. Texture resources are disposed with the foam subsystem.

The liquid, spray and foam remain separate named systems in the profiler. For custom secondary effects,
reuse the ordinary subsystem eligibility and attachment APIs rather than adding another effect system.
See [surface attachment](../guides/surface-attachment.md) and [subsystems](../guides/subsystems.md).

<ExampleCode region="foam" />
