# Rendering Compatibility and Visual Validation

RZMPS supports Three.js WebGL and WebGPU rendering. WebGL uses CPU particle simulation. WebGPU can use either CPU simulation or GPU compute; `gpuProcessing` requests compute and `isGPUProcessingActive` reports the backend selected after renderer context is available. Component compatibility can still select CPU processing, so WebGPU rendering alone does not prove that simulation is on the GPU. See [GPU processing](gpu-processing.md) for eligibility and extension hooks. A browser must expose WebGPU on a secure origin; localhost is suitable for development. The preview command fails explicitly if the requested backend cannot initialize.

Initialize a WebGPURenderer before rendering. See the demo's `createWebGPURenderer` utility for the light-node registrations used by its scenes. Custom ShaderMaterial or other Three.js extensions can have their own backend constraints; check them before substituting materials.

The preview harness uses the shared example factory, a perspective camera at `(8, 6, 12)` looking at `(0, 2, 0)`, pixel ratio 1, a dark background, and ambient/directional lighting. It waits for example assets, performs an initial render to establish renderer/camera context, and captures immediately after rendering. WebGL preserves its drawing buffer; WebGPU submits and waits for render work. PNG data comes from the canvas, without browser-window screenshots.

```bash
npm run build:modules
npm run preview -- --example fire --backend webgl --warmup 60
npm run preview -- --example fire --backend webgpu --warmup 60
```

Use `--scene` to select a demo scene by its displayed name when validating collision geometry, environments, or specialized affectors. Scene factories and their cleanup contracts are reused. The default neutral scene makes differences between particle configurations easier to compare but cannot exercise scene-specific interactions. Audio cues are not represented in PNG captures.

Fixed steps and a seeded preview-local random source make comparisons more repeatable. They cannot guarantee identical pixels across devices, renderer implementations, or asynchronously changing external inputs. Preview generation does not change the application's default randomness. Built-in example prewarm is disabled in the harness so `--warmup` controls the exact number of initial steps.

Inspect `contact-sheet.png` for motion, scale, density, clipping, and fade timing. Read `metadata.json` for backend, camera, timestep, times, population, and browser warnings. Technical success does not establish artistic quality; vary warmup and interval when the important event is outside the captured window.

Selected scene presets supply their own lighting. Checkerboard exposes **Scene Settings → Light Strength** in the
demo; for captures, use `--scene Checkerboard --scene-light-strength 0.08` to dim its ambient and point lights without
changing particle lights. The default multiplier is 1.

The default camera can clip broad or elevated effects. Override it with
`--camera-position 8,15,32 --camera-target 0,12,0 --camera-fov 50` for fireworks.
The coordinates and FOV are recorded in metadata so comparisons can reuse them.
Captures also record each root system’s simulation speed and scaled elapsed step time.

## Scoped rendering diagnostics

After building the library, run the standalone diagnostic without regenerating docs or example previews:

```bash
node scripts/preview/rendering-diagnostics.mjs --backend webgl --check --output /tmp/rzmps-render-webgl
node scripts/preview/rendering-diagnostics.mjs --backend webgpu --check --output /tmp/rzmps-render-webgpu
```

Add `--material lit` to exercise the lit-sprite variant.

It captures LiveCubemap's -Z face and the normal camera for four states: distortion, unmodified scene color,
a one-pixel scene-color offset, and ordinary particles. `report.json` records cameras, target/copy dimensions,
texture identities, feedback checks, and UV normalization. `--check` also captures legacy/corrected decal ordering
from three camera angles, checks occlusion behind an opaque surface, and reads GPU child-rotation results on WebGPU.
Initialization, capture, shader errors, or failed controls fail the command explicitly.

Sprite materials retain transmission and distortion during native cubemap capture, for lit/unlit materials and
CPU/GPU particles. Each cube face is already a perspective image: the usual projection-scaled screen UV offset applies
within that face. As with other screen-space effects, refraction cannot retrieve geometry outside the current face.
`excludeParticleRenderers` still explicitly hides all particle renderer objects when requested.

Three r186's WebGPU framebuffer copy omits the active cube layer, sampling face 0 for every camera. The scene-color
node temporarily supplies that missing layer to the backend copy helper, retaining Three's render-pass handling and
restoring the helper in `finally`. This narrow compatibility shim uses a private Three method; when unavailable, the
shader falls back to alpha `opacity * (1 - transmission)`, including the transmission map, rather than opaque color.
WebGL uses its native active-face framebuffer copy.

Scene-color textures are cached per render target instead of sharing one texture that resizes between probe and main
views. The earlier 2D staging workaround is removed: no additional face renders or face-staging copies are needed.
A stalled frame drops missed captures rather than replaying them above the configured frequency. Cubemaps still require
six ordinary scene renders; `fps` and `resolutionScale` control that remaining cost.

The diagnostic compares all six native cube faces with independent 2D renders of the same face cameras, verifies the
actual copied layer, checks distortion controls on cube and main views, and compares the alpha fallback against an
ordinary material with equivalent opacity. It also checks that no face-staging copies occur.

Probe cameras skip soft-particle fading against the main camera's depth prepass, matching the WebGL path. Ordinary
depth testing remains active; main-camera soft intersections retain their existing behavior.

WebGPU soft-particle depth belongs to each scene and renderer, with both CPU/GPU sprite samplers refreshed on update.
It is not a global texture shared by unrelated render targets. This preserves depth ownership and bindings across
scene changes, canvas resizing and GPU texture recreation. Minimized depth targets are clamped to one pixel, and failed
prepasses release their rendering guard so later updates can recover.

To check depth ownership, resizing, background-tab/frozen-page return, target recreation and moving intersections:

```bash
node scripts/preview/rendering-diagnostics.mjs --backend webgpu --soft-depth --check --output /tmp/rzmps-soft-depth
```

The report records target/texture dimensions, sampler ownership and intersection pixels before and after these changes.

Live cubemap captures reuse existing light shadow maps while the capture owner or particle renderers are hidden.
They restore per-light update flags and WebGL's global shadow flags, including pending manual updates, even after an
interrupted capture. This prevents probe passes from erasing a hidden object's main-view shadow after a depth prepass.

```bash
node scripts/preview/rendering-diagnostics.mjs --backend webgpu --shadow --check --output /tmp/rzmps-cubemap-shadow
```

The shadow regression compares main-view pixels before and after repeated captures in the same animation frame as a
main-camera prepass, and verifies that the probe does not trigger shadow-map renders.
