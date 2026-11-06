# Material Copying and Compositing

Material copying binds accessible surface inputs to a particle. Compositing combines those inputs
with the renderer's configured material. It copies color, opacity, tangent-space normal maps,
roughness, metalness, and compatible environment inputs; it does not evaluate the source's lighting, custom GLSL, or TSL graph.
Source materials and textures remain caller-owned and unchanged.

## Environment Maps

Environment textures remain borrowed rather than being baked into the surface atlas. Persistent decals
copy their selected material's `envMap`, `envMapIntensity`, and `envMapRotation` when supported by the
destination material. A live capture keeps updating through that shared texture reference; destroying a
particle system or decal never disposes the source environment texture.

A shared mesh draw uses an explicit `materialTarget` environment, or a compatible environment shared
by the registered copied materials. Distinct captures, intensities, or rotations cannot vary inside one
shared material; that case retains the renderer's configured environment. Decals have independent
materials and can use different captures. Separate renderer tag groups with explicit material targets can select different shared captures.
A particle system's own live cubemap takes precedence on its
mesh renderer. Lit sprites inherit compatible environment maps and intensity unless their own environment
options or system capture override them.

WebGL shaders omit empty atlas channels, reuse destination texture samplers, and use uniforms for a
single-material palette. This leaves texture units available for environment maps, shadow maps, and
light-probe textures; the changes add no GPU storage buffers.
Atlas growth reserves power-of-two tile capacity with spare cells, avoiding rebakes when the next source fits.
Empty atlas channels defer GPU allocation until used unless a minimum capacity is explicitly requested.
Set `atlasOptions: { minCapacity: 4 }` in renderer options to reserve at least four tiles per copied-map channel.
This is a creation-time setting; capacity rounds up to a power of two and can grow beyond that minimum.
In automatic-resolution mode, pixel storage grows when larger source textures arrive.
The underlying `TextureAtlas` option is `minCapacity`, for example `new TextureAtlas({ minCapacity: 4 })`;
its first `update(renderer)` allocates that storage even with no sources, without submitting bake draws.
The same renderer `atlasOptions` configures sprite texture lists and mesh source palettes, including `tileSize` and
`padding`. Copied material channels retain their required color spaces automatically.

By default tiles preserve the largest source texture dimension, up to `atlasOptions.maxTileSize: 2048`.
All tiles in a channel share that resolution; adding a larger image grows the tiles and rebakes existing sources.
An explicit `atlasOptions.tileSize` selects a fixed resolution instead. The complete padded atlas also respects
hardware texture-size limits, reducing tile resolution if necessary. Tiles do not otherwise shrink during use.

Set renderer `textureCopyQuality` to a factor in `(0, 1]` (default `1`) to reduce copied-map resolution before
applying the cap. For example, `textureCopyQuality: 0.5` requests 512-pixel tiles for 1024-pixel source maps.
This creation-time option applies to every copied map channel, including normal and roughness maps, without
modifying the original textures. It also scales an explicit copied-map `tileSize`; sprite texture lists and mesh
source palettes retain their own atlas settings. Use `atlasOptions: { maxTileSize: 512 }` to cap those atlases too.
Borders are extruded and mipmaps are disabled. `TextureAtlas.sample()` retains valid TSL coordinates across
resolution and capacity changes; direct consumers of `rect()` should refresh their rectangles when `version` changes.

Lit WebGL sprites also eliminate absent optional map branches at shader creation, rather than reserving samplers
behind runtime false flags.

`LiveCubemap` remains independent of particle systems: attach it to an object and call `update(scene, renderer, dt)`.
On WebGL it finishes PMREM filtering inside that update and publishes the filtered environment through `map`.
Consumers can keep the same texture reference as captures change, without triggering nested filtering during
material draws. WebGPU keeps its native cube-texture path. `excludeParent` skips the owner during capture;
`dispose()` releases capture/filtering resources and removes the owned cube camera.

## Bind a Surface at Birth

```ts
import { MaterialCopy, MaterialCopySource, MaterialCopySampleMode } from '@rzmps/rzmps';

const fragments = new ParticleSystem({
  emitters: new Emitter({ rate: 0, bursts: [{ time: 0, count: 8 }] }),
  modules: [new MaterialCopy({
    source: MaterialCopySource.Collision,
    sampleMode: MaterialCopySampleMode.UVPatch,
  })],
  renderers: new MeshRenderer({ mesh: fragmentMesh }),
});
parent.addSubSystem(fragments, { emitOnCollision: true });
```

The module receives the triggering collision synchronously during initialization, before spawn
listeners, simulation and rendering. It registers the hit material and stores `materialCopy`,
`materialCopyU` and `materialCopyV`. Native GPU births perform the same work in their emission
kernel, retaining event snapshots in the existing run storage without CPU readback or another binding.
The former subsystem `copyCollisionMaterial` option is replaced by this module.

`UVPatch` retains the impact UV and triangle's world-space UV gradients across the fragment's
birth pose. It preserves local texture density, orientation and shear, then travels with the piece.
It approximates one triangle's chart; it cannot reconstruct adjacent triangles, seams or curved surfaces.
Billboards retain density and shear in their sprite plane. `Color` samples each supported map at
the impact UV, while `Texture` uses the particle geometry's own UVs. Color samples stay fixed at
the contact UV even when particles are born away from the contact point. Missing charts fall back to
ordinary texture mapping, or the center sample in Color mode.

Use `source: MaterialCopySource.Event` for event payloads shaped as `MaterialCopyInput`, or
`source: MaterialCopySource.Source` for registered-source `metadata` with that shape. A parent
particle's existing binding can also be inherited through Source mode. A static material or mesh
can be supplied directly as `source`. CPU `resolveSource(particle, context)` and TSL
`resolveSourceGPU(particle, context)` adapt application-specific inputs. Supply both resolvers
when supporting both processing backends. Native custom-event payloads are packed vectors;
use the GPU resolver to interpret `context.event.data` and return a registered binding and chart.

A `MaterialCopyInput` contains `material` (or an existing `materialSourceId`), an optional
`surface: { uv, u, v }`, and `point`. Surface gradients are world-space covectors; `point` is in
`context.sourceToWorld`'s simulation frame. A GPU resolver returns `binding` (ID, U, V, mode),
optional world-space gradients `u`/`v`, and an optional world-space `point`.

Subscribe with the module's existing `events` option to update bindings on later events targeting
the particle. Initialization needs no event subscription and does not wait for event delivery.
See [emission sources and events](emission-sources-events.md) for event timing and payloads.

For a renderer-wide source, use `materialTarget` or `renderer.copyMaterial(material)`;
no MaterialCopy module is required. Sprites, meshes and decals share the appearance pipeline.
Composited decals can also bind their hit surface automatically when neither a particle binding
nor an explicit materialTarget is supplied. Audio and light renderers ignore material compositing.

## Combine Material Inputs

The default combines copied color, opacity, roughness and metalness multiplicatively with the
configured particle material, and perturbs its normal. White and one preserve source values.
A callback overrides only the returned channels; all other channels retain the destination value.
An absent or invalid copied source falls back to the destination inputs.

```ts
const view = new MeshRenderer({
  materialComposite: (source, dest, context) => {
    context.function('blendColor', `
      vec3 blendColor(vec3 source, vec3 dest) { return mix(source, dest, 0.25); }
    `);
    return { color: `blendColor(${source.color}, ${dest.color})`, opacity: dest.opacity };
  },
  materialCompositeGPU: (source, dest) => ({
    color: mix(source.color, dest.color, 0.25),
    opacity: dest.opacity,
  }),
});
```

Import `mix` from `three/tsl` for the GPU example. `materialComposite` builds GLSL expressions;
`materialCompositeGPU` builds TSL nodes. They execute when constructing shaders, not per pixel
in JavaScript. Selection follows the rendering backend: CPU simulation rendered with WebGPU
still uses the TSL callback. Supply both callbacks for applications supporting both renderers.
Assign a new callback to rebuild shaders. If a callback closes over changed configuration, set
`renderer.needsUpdate = true`. GLSL helper names are deduplicated, and conflicting definitions throw.

Color channels use linear RGB. Opacity, roughness and metalness are scalar inputs. Public normal
channels are normalized **view-space** directions: sampled source tangent normals are converted
using the sampled UV chart and destination surface derivatives before compositing. Normalize any
custom normal blend. Source shaders, procedural node outputs and unsupported texture dimensions
are not evaluated. Supported maps use UV0; unavailable maps use neutral samples with the source's
numeric material fields. Normal-map support assumes tangent-space maps.

`context.geometricNormal` supplies the unperturbed view-space normal. Comparing it with the
destination normal can mask a normal-only decal to the pixels that change shading. The lazy
`context.destMapAlpha` multiplies available destination normal, roughness and metalness map alpha
channels (one for unavailable maps). Combine it with `dest.opacity`, which already includes the
base map and alpha mask. No CPU pixel reads are needed. This provides a fallback for damage textures without
an explicit opacity mask.

[Destruction](../examples/destruction.md) uses matching normal, roughness, AO, and opacity maps from one selected
material. Its roughness multiplies the copied surface roughness, while the surface supplies color and metalness.
The opacity mask blends the resulting damage lighting over the original surface once, avoiding a second alpha
interpolation of individual channels. `material.normalScale.setScalar(2)` strengthens the impact normals.
[Doppler Bullet](../examples/dopplerBullet.md) uses the same coverage approach with albedo alpha and a bullet-hole
roughness map. Its damage albedo is tinted by the sampled surface color, and its roughness replaces the surface
roughness within the mark. Both preserve the surface's normal detail alongside the damage normals.

## Sample a Channel Again

```ts
materialComposite: (source, dest, context) => ({
  color: context.sampleSource('color', `(${context.sourceUV} + vec2(0.01, 0.0))`),
  normal: dest.normal,
}),
materialCompositeGPU: (source, dest, context) => ({
  color: context.sampleSource('color', context.sourceUV.add(vec2(0.01, 0))),
  normal: dest.normal,
}),
```

`sourceUV` is the selected source chart coordinate before map transforms and atlas placement.
Resampling preserves material selection, map transforms, wrapping and atlas aliases. Request any
supported channel repeatedly at different coordinates. Unused source nodes are omitted from the
TSL shader graph. All sampling happens on the GPU; there is no canvas pixel readback.

`sampleDest(channel, coordinates)` resamples destination inputs where supported. The GLSL path
supports built-in color/opacity maps and standard roughness/metalness maps; destination normal
resampling falls back to the current destination normal. TSL resampling uses the destination
node's UV context; nodes with explicit fixed UVs retain those UVs. `destUV` is the renderer's
original texture coordinate. Alpha testing, clipping and ordinary lighting continue through the
destination renderer's material stages.

See [Destruction](../examples/destruction.md) for collision UV patches, atlas constraints,
mesh variation and an example rendered with both backends.
