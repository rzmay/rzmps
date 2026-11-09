---
title: "Doppler Bullet"
example: dopplerBullet
---

# Doppler Bullet

A piercing bullet leaves surface-blended bullet holes, with Doppler audio, smoke, faint trails and a distortion wake.

[View live example](https://rzmps.rzmay.com/?preset=Doppler%20Bullet)

<ExampleAttribution />

<ExamplePreview />

## Particle System Configuration

The root loops over 5.5 seconds, caps at eight particles, and disables gravity for nearly straight flight. Five subsystems provide smoke wake, heat wake, muzzle flash, spawn shockwave, and impact dust. Their inheritance factors are zeroed so the small fast bullet does not force every secondary effect to copy its scale or velocity.

<ExampleCode region="system" />

## Emitters

The bullet emits at rate 0.9 with lifetime 1.9 seconds and z velocity from -31 to -36. Its source cone is placed near z=34, giving it a long path across the scene. Smoke uses rateOverDistance 5, maintaining wake spacing as the bullet moves; flash and shockwave use time-zero bursts rather than continuous emission.

<ExampleCode region="emitters" />

## Modules

The root has no explicit module list; piercing marks use no Collision module and never change bullet velocity. Secondary smoke uses force, noise, growth, rotation, and a fade envelope. Heat and shockwave systems grow while distortion fades; flash color shifts from pale yellow to orange. These separate timing curves keep the initial flash brief while the slower wake remains visible.

<ExampleCode region="modules" />

## Renderers

The metallic mesh is paired with a faint 0.28-second trail of width 0.055 and opacity 0.22. AudioRenderer uses dopplerEffect 2.4, speed/depth volume response, and pitch variation to emphasize a fast flyby. The 5×4 flash atlas plays at 36 fps, while non-billboard, double-sided distortion sprites show the shockwave from either side.

A DecalRenderer uses the `DecalRenderer.Intersect()` direction sampler at `continuousRate: 60`
and `hitSelection: DecalRenderer.All`
to sweep each traveled segment and mark entry and exit faces. Its 0.55-unit bullet-hole decals
last 24 seconds and fade during the final fifth, with a cap of 128 marks. Albedo alpha, normal
and roughness maps combine with the hit surface through shared GLSL/TSL compositing. The albedo's alpha
masks every damage channel together through transparent blending, rather than using fixed normal/roughness blend weights.
The surface's own normal detail is layered onto the bullet-hole normal before lighting. Within the mark,
roughness comes from the bullet-hole map; destruction impacts instead multiply their roughness map by the surface value.
Both WebGL and WebGPU preserve the albedo alpha during compositing. Each hole copies its hit mesh's
`receiveShadow` setting at creation and borrows the surface's environment map where applicable.
Texture loading, the bullet-hole material, and both compositor callbacks are defined inline in the factory,
so the source excerpts include the complete damage setup. Each hole uses an independently randomized projector roll. Surface UVs stay independent of the damage projector UVs.
Each hole registers a source tagged `bullet-hole`, carrying the original surface material and impact
UV in its metadata. Source birth triggers one burst of 5–8 smoke particles, with 0.4–0.65-second
lifetimes, 0.28–0.44-unit starting sizes, and 30–45% initial opacity. The puff starts just outside the surface and moves outward;
a short 0.025-unit soft-particle fade keeps it visible near the wall.
A named spawn transformer derives the outward velocity from the decal source frame, instead of
using a world-up initial velocity. `MaterialCopySource.Source` with `MaterialCopySampleMode.Color` samples
that fixed impact UV, so each puff has a uniform surface color instead of a UV patch or the dark
bullet-hole albedo or projectile tint. Its composition callback overrides only color, retaining the smoke's own mask
and lighting. WebGL sprites apply Three.js tone mapping and output color conversion before display;
otherwise linear cream surface colors look dark and bronze despite a correct material binding.
Dust reuses the decal's original surface metadata instead of casting another ray; projection excludes
particle-renderer geometry, including the bullet's instanced mesh.
The source's +Y axis points outward, directing the puff away from the surface.

The primary emitter tags bullets `projectile`. The flash, shockwave and continuous wake relationships
select that tag, while dust selects `bullet-hole`. Registering a hole is a source spawn event; these
filters keep that event from replaying the gunshot effects or leaving a wake on a stationary decal.

Choose **UV debug** to see the holes on its wall and ramp. The preset itself adds no scene geometry.

<ExampleCode region="renderers" />

