# Surface Decals

`DecalRenderer` clips persistent geometry onto rigid scene meshes with Three.js `DecalGeometry`. Pass a material or a nonempty list of materials first
and an optional options object. Each mark owns a material clone and geometry; your material, textures, and target
geometry remain caller-owned. Standard Three.js materials work with WebGL and WebGPU rendering.
Each decal copies the hit mesh's `receiveShadow` setting at creation, so lit decal materials receive the same
scene shadows as their surface.

```ts
import * as THREE from 'three';
import { DecalRenderer } from '@rzmps/rzmps';

const material = new THREE.MeshBasicMaterial({ color: '#542710' });
const decals = new DecalRenderer(material, {
  direction: new THREE.Vector3(0, -1, 0),
  maxDistance: 2,
  depth: 0.1,
  size: 1,
  lifetime: 8,
  opacity: t => 1 - t,
});
// Supply decals in a ParticleSystem's renderers collection.
```

Pass `[impact1, impact2, impact3]` to choose a complete material randomly for each mark. Normal, roughness, alpha, and AO maps
stay paired because selection happens once before cloning the material. Repeated hits from the same particle can
choose different templates. `materialIndex` optionally selects a zero-based index (a dynamic number); it is rounded down
and clamped to the available range. Existing marks retain their selected template when composition callbacks change.
Templates and textures remain caller-owned. This uses `StrictMultiple<THREE.Material>` and adds no GPU storage buffers.
Ready image textures on the supplied materials upload once per Three.js renderer during normal updates,
before a collision needs a new variant. Pending images are retried when ready; render-target textures stay under
their producer's control. This requires no separate atlas initialization or loading API.

For a normal-only impact, put its matching mask in `alphaMap`. Optional `aoMap` is supported by standard materials;
set `aoMap.channel = 0` to use the same projector UVs. Keep these data maps in `THREE.NoColorSpace`.
Adjust a template's `normalScale` to control its normal-map strength; `material.normalScale.setScalar(2)` doubles
both tangent-plane components. This is independent of `DecalRenderer.size` and particle scale inheritance.

Spawn projection is enabled by default. Set `onSpawn: false, onCollision: true` for contact marks, or `onDeath: true` to
search from the final particle position. Triggers are independent; enabling two can deliberately create two sets of
marks for one particle. `continuousRate` defaults to zero (disabled). Set `onSpawn: false, continuousRate: 2` to project
from each live particle twice per second instead of waiting for a collision. Its first projection occurs after one
interval, so a particle that dies sooner than `1 / continuousRate` never projects continuously. Birth, collision, and
death switches still work independently when continuous placement is enabled.

Continuous placement follows particle simulation age, respects tag filters, and stops when the particle dies. Pause
freezes placement and decal aging; stopping emission without clearing lets surviving particles keep projecting. Repeated
processing of the same particle snapshot does not duplicate an interval. If a large step crosses multiple intervals,
missed projections use the current particle state, with catch-up work limited to `maxDecals` per particle per update.
Clear/reset discard timing history; attaching to an already living population does not replay its entire past. Emitters,
bursts, distance-based emission, and subsystems continue to determine which particles exist.

`ratio` defaults to `1` and is clamped to `[0, 1]`. It selects a consistent fraction of particles by ID for all
projection triggers, including continuous placement. Setting it to zero disables new projections; existing decals
continue fading.

Constructor settings are exposed directly as renderer properties, for example `decals.continuousRate = 2` or
`decals.size = 1.5`; there is no stored options object. New configuration affects subsequent projections, while existing
marks keep their creation-time properties. Numeric configuration is clamped instead of throwing: distance and depth
remain positive, capacities/counts are rounded down, capacity/rate cannot be negative, and nonfinite values use defaults
(or zero for an explicit invalid hit count). Radial ray counts are rounded down to at least one, with nonfinite counts
becoming one.

Directions are world-space vectors. The exported `DecalDirectionSampler` and `DecalHitSelection` types describe
direction and selection callbacks. A direction callback receives the original particle in its simulation space and may
return one vector or an ordered array. Nonzero finite vectors are normalized without modifying them.
`DecalRenderer.Radial(24)` returns twenty-four deterministic Fibonacci-sphere directions. Local particle positions are
transformed into world space before querying.

`DecalRenderer.Forward()` samples local +Y transformed by `particle.rotation`, matching the forward-axis convention in
`OrientToDirection`. Its optional `THREE.Vector3` supplies an XYZ rotation offset in radians, applied in the particle's
local frame before its rotation. For example, rotate X by π to point backward:

```ts
const decals = new DecalRenderer(material, {
  direction: DecalRenderer.Forward(new THREE.Vector3(Math.PI, 0, 0)),
});
```

Forward follows orientation; use `OrientToDirection` when orientation should follow velocity. As with any particle-aware
sampler, a rotated local simulation needs a callback that transforms the returned direction to world space using the
system's world matrix. Samplers leave particle state and caller-owned vectors unchanged.

## Marks Along a Moving Particle's Path

`DecalRenderer.Intersect()` is a direction sampler alongside Forward and Radial. It returns a bounded
`THREE.Line3` from the ordinary projection context's previous position to its current position,
so a fast projectile can pass through a thin wall without a Collision module or any velocity change.
Use `hitSelection: DecalRenderer.All` to mark every crossed entry and exit surface:

```ts
const holes = new DecalRenderer(bulletHoleMaterial, {
  direction: DecalRenderer.Intersect(),
  continuousRate: 60,
  onSpawn: false,
  hitSelection: DecalRenderer.All,
  size: 0.55,
  depth: 0.04,
  inheritScale: 0,
  inheritColor: 0,
  lifetime: 24,
});
```

The existing `continuousRate` controls sampling; no separate intersection mode or lifecycle tracking is installed.
Movement segments use simulation-space coordinates and are transformed to world space for querying.
Custom samplers may also return `THREE.Line3` or arrays mixing segments and world-space direction vectors.
They receive an optional second `DecalProjectionContext` argument containing `deltaTime`, `position`,
and `previousPosition`. Continuous projection tracks this history for every sampler, including skipped frames.
Ordinary `maxDistance` limits direction rays; a segment defines its own range. `maxHits`, tags, ratio,
capacity and lifetime still apply. Use All to select each crossed entry and exit.

A reverse ray finds outward-facing exit faces without modifying target materials or shaders.
Triangle-seam duplicates are removed, while distinct entry/exit points on one mesh remain separate.
Meshes keep their existing raycast side rules. Each sampled segment is straight, so a curved path
is approximated by its successive samples. Native GPU simulation uses asynchronous selective
particle snapshots, with no added compute buffers. Velocity estimates the first interval when no
previous projection position is available.

## Blend with the Marked Surface

With `materialComposite` / `materialCompositeGPU`, a decal without an explicit `materialTarget`
or a preassigned particle binding uses its hit surface as the source. The shared appearance pipeline
registers the face's material and extends its triangle UV chart across the clipped geometry.
Each mark keeps an independent binding; the projectile's material and the target's material are
unchanged. A compatible decal material also borrows the source environment map, intensity, and rotation,
so a mark on reflective metal retains its reflections. Destination maps retain the projector UVs, so a crack or hole can blend into the original
surface pattern without stretching that pattern to the decal footprint.

The [Destruction example](../examples/destruction.md) uses collision-triggered concrete cracks;
[Doppler Bullet](../examples/dopplerBullet.md) uses Intersect with albedo, normal and roughness maps.
Destruction instead uses only damage normals over the original material. Its opacity mask compares
the mapped normal with `context.geometricNormal` and multiplies by `context.destMapAlpha`, so flat
normal regions and transparent map pixels do not cover the target. The supplied height maps do not
displace geometry. See [material compositing](material-copying.md) for callback semantics.

Each direction ray contributes its first supported intersection; bounded segments include entry and exit faces. Search uses a configured `ThreeCollisionBackend`'s current
membership, including explicit object lists and filters; without that backend it scans scene meshes using the shared
collision exclusions. Particle renderer objects and decal meshes are excluded. Other physics backends supply contacts
directly when their `CollisionHit.object` is a supported mesh; otherwise search falls back to scene geometry. A valid
collision contact bypasses direction sampling and raycasting. When mesh identity is unavailable, a finite nonzero
collision normal selects the opposite world-space search direction, including on walls and slopes; the configured
sampler is used only when that normal is unavailable. The built-in octree backend currently lacks target identity, so it
uses this fallback, which can differ from an aggregate capsule contact.

`maxDistance` limits ray length in world units (default 2). `depth` is the projector's Z clipping thickness (default
0.1); width and height come from `size` and inherited X/Y scale. Normals use the mesh normal matrix, and particle Z
rotation supplies projector roll in radians. `offset` displaces generated vertices along the outgoing normal (default
0.001). Keep depth shallow on thin or curved targets: clipping can reach nearby faces and corners can distort the
projection.

`hitSelection` defaults to the direct callback `DecalRenderer.Nearest`. It receives `(hits, particle, maxHits)`, with
`THREE.Intersection` candidates in ray order. `face.normal` and optional `normal` follow Three.js mesh-local
conventions; transform them with the target's normal matrix for world-space comparisons.

| Selector | Omitted maxHits | Explicit maxHits: 4 |
| --- | --- | --- |
| `DecalRenderer.Nearest` | One closest | Up to four closest |
| `DecalRenderer.Farthest` | One farthest | Up to four farthest |
| `DecalRenderer.All` | All in ray order | First four in ray order |

The built-ins leave the input array unchanged. Negative `maxHits` disables truncation; zero creates no marks. A custom
selector may return fewer candidates. Explicit nonnegative `maxHits` also caps its valid result. Distinct intersections
on one mesh remain separate candidates.

```ts
const decals = new DecalRenderer(material, {
  direction: DecalRenderer.Radial(24),
  maxHits: 4,
  hitSelection: (hits, particle, maxHits) => {
    const upward = hits.filter(hit => {
      const normal = (hit.normal ?? hit.face?.normal)?.clone();
      if (!normal) return false;
      normal.applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
      return normal.y > 0.5;
    });
    return DecalRenderer.Nearest(upward, particle, maxHits);
  },
});
```

`color` accepts `ColorInput` values (Three.js colors, CSS strings, or numeric hex values). `size` accepts
`Vector3Input`: a number for uniform width/height or a vector for separate X/Y dimensions; Z is ignored because `depth`
controls clipping. Both support callbacks, ranges, and sets without modifying caller-owned values.

`size`, `color`, and `lifetime` use the existing CPU `DynamicValue` helpers and are sampled once at source particle age.
Geometry never resizes after creation. Nonpositive or nonfinite lifetime/size creates nothing. Lifetime is in seconds;
its default is eight. `opacity` is evaluated on normalized **decal age** from zero to one, with a stable source seed for
random ranges. It multiplies the template material opacity and snapshotted alpha. CPU evaluation does not accept TSL
nodes.

`inheritColor`, `inheritScale`, and `inheritAlpha` default to 1 and follow subsystem math: base multiplied by `lerp(1,
particleValue, amount)`, component-wise for color and nonuniform scale. Zero and negative amounts retain the base value,
matching subsystem handling. Half blends halfway, and one inherits fully. The material color, configured color, and
inherited particle color multiply together. Each decal's material fades independently.

`distanceAffectsSize` and `distanceAffectsOpacity` default to zero. Their multiplier is `lerp(1, proximity, amount)`,
where `proximity = 1 - clamp(hit.distance / maxDistance, 0, 1)`. Zero is neutral and one gives full distance
attenuation.

`maxHits` limits selection per trigger. `maxDecals` instead limits active persistent marks (default 256). Insertion at
capacity evicts the oldest mark and disposes its geometry and cloned material. Expiry, `clear`, reset, removal from the
scene, and destruction also release owned resources. Pause freezes decal age; stopping without clearing lets marks
continue fading. Destruction unregisters callbacks. Renderer update/count LOD does not skip lifetime updates or
lifecycle placement; tag filters still apply. Normal system simulation LOD and culling affect the system clock as usual.

Generated geometry is stored in the target mesh's local space so it follows rigid motion. Skinned and instanced targets
are rejected; deforming geometry and animated morph targets are unsupported. Choose a material with a color property
when using tint inheritance. Texture and custom shader compatibility follow the supplied material's capabilities.

GPU event-only modes use the existing asynchronous lifecycle-event snapshots without adding particle readbacks.
Continuous mode uses the same `updateCPUFromGPU` helper as LightRenderer and TrailRenderer, forwarding snapshots through
the normal update path. There is no separate readback-frequency cap; the helper guards against overlapping requests.
Fixed direction vectors request position, rotation, normalized age, and elapsed age, plus scale/color/alpha when
inherited. Arbitrary direction callbacks may inspect every particle field, so those request complete snapshots. Decal
lifetimes still advance on each simulation update while a readback is in flight. Marks may appear after readback
latency. GPU contacts currently lack mesh identity and search opposite the collision normal. Follow-up work: preserve
GPU collision target identity for exact contact projection. Geometry clipping and material allocation remain CPU work;
batching and deforming mesh projection are deferred.

The [Splatter example](../examples/splatter.md) uses matte paintballs and long-lived collision marks that inherit color
and scale. The [Fire example](../examples/fire.md) uses continuous radial projection from its flame particles.
Short-lived, low-opacity marks fade in and accumulate into textured scorch patches. [Fireball](../examples/fireball.md)
uses the same texture with a higher continuous rate suited to its brief bursts.

## Event Parameters and Impulse Controls

`onSpawn`, `onCollision` and `onDeath` accept booleans or parameter callbacks. A callback receives
`(data, source, parameters)` and returns per-mark overrides; return `false` to cancel that mark.
Collision data is a `CollisionHit`. Spawn/death data is normally undefined. The source is the
original particle or registered handle; evaluated parameters are independent of it and the template.

```ts
const marks = new DecalRenderer(material, {
  onSpawn: false,
  impulseThreshold: 4,
  impulseAffectsSize: 0.3,
  impulseAffectsOpacity: 0.1,
  impulseAffectsLifetime: 0.2,
  onCollision: (hit, source, parameters) => ({
    size: parameters.size.clone().clampScalar(0.5, 1.4),
  }),
});
marks.onEvent('splash', (data, source, parameters) => ({ lifetime: parameters.lifetime * 2 }));
// The constructor form is onEvent: { splash: callback }, or onEvent: ['splash'] for default parameters.
```

Impulse multipliers are `magnitude ** amount`, with zero amounts neutral. The collision threshold
runs first; dynamic values, inheritance, proximity and impulse effects are evaluated before the
callback. `DecalParameters` exposes world-space `position` and `normal`, world-space XY `size`,
`rotation`, `color`, base `opacity`, `lifetime`, `depth` and `offset`. The age-dependent renderer
`opacity` envelope still multiplies the mark's base opacity. Each selected hit gets its own snapshot;
selection, tag/ratio filtering and capacity checks still apply. Position overrides remain clipped to
the selected target mesh.

`rotation` is additional roll in radians, default zero. A range such as `[-Math.PI, Math.PI]` is
sampled independently per mark, including entry and exit marks from the same particle. The registered
source frame uses the same roll as the geometry. Source particles are never rotated.

Built-in event names are `spawn`, `death` and `collision`. `marks.onEvent('collision', callback)`
selects the same trigger as `onCollision: callback`; an explicit onEvent entry takes precedence,
so the same event is not processed twice. Calling onEvent again replaces that name's handler.
`onEvent('continuous', callback)` transforms parameters for continuous projections, including Intersect
samples. Direction samplers do not publish particle collisions.

All named events use the same EventReceiver subscription path and `eventScope` rules. Lifecycle aliases
select the corresponding `spawn`, `death`, or `collision` name, including registered-source events.
Parameter callbacks run once at dispatch, retaining synchronous CPU placement and the existing native
GPU snapshot delivery. Use tags to filter sources and avoid feeding a decal source back into itself.

## Emitting from Persistent Decals

Set `emissionTags: ['acid-pool']` to register each successful decal as an emission source.
The public `decals` collection exposes `decal.source`; call `decal.source?.emitEvent('bubble', payload)`
from application scheduling code. Sources follow decal transforms, rigid surface movement, material
color and opacity, and are disposed on expiry, eviction, clear or renderer destruction.
A child with `{ tags: ['acid-pool'], emitContinuous: true, inheritLifetime: 0 }` can emit smoke
from every pool; another with `onEvent: ['bubble']` can produce splashes.

Sources also expose `metadata.material`, `metadata.surface` (impact UV and world-space UV gradients),
and `metadata.point` in the producing system's simulation frame. A source-born particle can use
`MaterialCopy({ source: MaterialCopySource.Source, sampleMode: MaterialCopySampleMode.Color })`
to sample a single surface color. Color mode holds the impact UV fixed even when births spread
around the source. Doppler Bullet combines this with `{ tags: ['bullet-hole'], emitOnSpawn: true,
inheritLifetime: 0 }` for one brief puff per persistent hole. Filter other spawn-triggered effects
by their projectile tag so a registered source birth does not replay those effects.

See [Emission Sources and Custom Events](./emission-sources-events.md) for handle APIs and deferred
synchronization, and [Acid](../examples/acid.md) for the complete effect.
