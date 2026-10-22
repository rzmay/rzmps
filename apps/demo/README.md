# 🧅 RZMPS Demo

Interactive browser demo for
[RZMPS](https://www.npmjs.com/package/@rzmps/rzmps), a modular particle system for
[Three.js](https://threejs.org/).

| Resource | Link |
| --- | --- |
| Live demo | [rzmps.rzmay.com](https://rzmps.rzmay.com) |
| npm package | [npmjs.com/package/@rzmps/rzmps](https://www.npmjs.com/package/@rzmps/rzmps) |
| GitHub repo | [github.com/rzmay/rzmps](https://github.com/rzmay/rzmps) |

This app is the development playground and showcase for the RZMPS package. It
uses React, React Three Fiber, Vite, lil-gui, and the local monorepo packages
for `@rzmps/rzmps` and the optional physics integrations.

## Table of Contents

- [What It Shows](#what-it-shows)
- [Demo UI](#demo-ui)
- [Editor Structure](#editor-structure)
- [Scene Settings](#scene-settings)
- [Local Development](#local-development)
- [Building](#building)
- [Monorepo Package Notes](#monorepo-package-notes)
- [Project Structure](#project-structure)
- [Adding Presets](#adding-presets)
- [License](#license)

## What It Shows

The demo includes particle presets for common renderer and module combinations:

- Fire
- Fireball
- Smoke
- Additive Smoke
- Snow
- Suzanne
- Spheres
- Cube Instances
- Suzanne Instances
- Particle Trail
- Ribbon Trail
- Collision
- Bubbles with positional audio
- Fireworks with subsystems
- Cubes and Spheres with tags

It also includes scene presets for testing environment behavior:

- Checkerboard
- HDRI lighting
- Color lights
- Built-in Three.js collision
- Ammo collision
- Rapier collision
- Jolt collision
- Wind force field
- Repulsor / attractor force fields
- Vortex force field
- World simulation space
- Light probe room based on the Three.js light probe example

## Demo UI

The landing sidebar introduces RZMPS, displays the library version, and links to
getting started, guides, API documentation, GitHub, npm, and contributors. Visitors
can share projects through the GitHub project submission form. The contributor avatars are
curated in `src/components/LandingLayout.jsx` and link to GitHub profiles.

Use the sidebar toggle to give the demo the full window, or press Escape to close
the sidebar. The sidebar starts open on each page load and overlays the full-size
canvas, so opening or closing it keeps the scene centered. The sidebar slides in
and out with the FPS and particle monitors following its edge; reduced motion
preferences disable the animation. Its Roboto Mono fonts are served locally, and
its colors follow the system light or dark theme.

The right-side editor is powered by `lil-gui`.

Use it to:

- switch particle presets
- switch scene presets
- start, pause, resume, stop, and clear the active particle system
- edit system gravity and simulation space
- tune emitter values, bursts, tags, and emission shapes
- edit subsystem trigger and inheritance options
- add and edit built-in modules
- add and edit built-in renderers
- toggle generated code output with `Show code`
- open the selected particle and scene preset source files on GitHub

The generated code panel is intended as a quick way to inspect how the current
particle system is configured.

## Editor Structure

`src/gui/ParticleSystemGUI.js` is the public GUI entry point. Focused editor
helpers live in `src/gui/particle-system-gui/`.

The editor explicitly controls initial folder state instead of relying on
`lil-gui` defaults.

Open by default:

- System
- Each emitter
- Each module
- Each renderer
- Emitter Initial Values
- LightRenderer Point Light settings

Closed by default:

- Scene Settings
- Update / Count LOD
- Emission Shape
- Bursts and individual bursts
- Vector2 / Vector3 editors
- Generic nested object / array / set editors
- Sprite Material Options
- Mesh / Trail Material
- Audio Clips

## Scene Settings

Scene builders are backward compatible and may simply return a cleanup function:

```js
export function buildScene(scene, renderer) {
  // setup...

  return () => {
    // cleanup...
  };
}
```

Scene builders can expose GUI controls by returning a lifecycle object with a
`gui` hook. This is preferred when controls need access to objects created while
building the scene:

```js
export function buildScene(scene, renderer) {
  const light = new THREE.DirectionalLight(0xffffff, 2);
  scene.add(light);

  return {
    cleanup() {
      scene.remove(light);
    },
    gui(folder) {
      folder.add(light, 'intensity', 0, 10).name('Light Intensity');
    },
  };
}
```

The optional `update(deltaTime)` lifecycle member works alongside `cleanup` and
`gui`. A scene builder can also expose static controls with
`buildScene.gui = (folder, scene, renderer) => { ... }`; lifecycle `gui` takes
precedence when both are present. For simple mutable state, `gui` may be an
object and the generic value editor will expose its fields.

## Local Development

From the repo root:

```bash
npm install
```

Build the local RZMPS packages before running the demo if you want to test
unpublished workspace changes:

```bash
npm run build --workspace packages/rzmps
npm run build --workspace @rzmps/rapier
npm run build --workspace @rzmps/jolt
npm run build --workspace @rzmps/ammo
```

Start the demo:

```bash
npm start --workspace apps/demo
```

Vite prints the local URL, usually:

```txt
http://localhost:5173
```

## Building

Build the demo from the repo root:

```bash
npm run build --workspace apps/demo
```

The static output is written to:

```txt
apps/demo/dist
```

The demo build script currently uses:

```bash
vite build
```

The Vite config aliases `@rzmps/rzmps` to the sibling package build output so
the demo can pick up local library rebuilds during development.

## Monorepo Package Notes

The demo imports `@rzmps/rzmps`, `@rzmps/rapier`, `@rzmps/jolt`, and
`@rzmps/ammo` as npm packages. Local development from the repo root uses npm
workspaces, so those packages resolve to sibling package folders. Build from the
repository root with `npm run site:build` to bundle the workspace packages and documentation.

The publishable packages each have a `prepack` script, so `npm pack` and
`npm publish` build their `build/**/*` output automatically. The demo itself is
not published to npm.

## Project Structure

```txt
apps/demo
├── public
├── src
│   ├── assets
│   ├── components
│   ├── gui
│   ├── pages
│   └── presets
│       ├── particles
│       └── scenes
└── package.json
```

Useful places to start:

- `src/components/ParticleSystemDisplay.jsx`: loads the active particle preset
  and updates the particle system each frame.
- `src/gui/ParticleSystemGUI.js`: editor controls, preset switching, and code
  serialization.
- `../../examples`: canonical particle system examples.
- `src/presets/scenes`: scene setup examples, including physics backends.

## Adding Presets

Add a particle factory in the root `examples/` directory with exported metadata and
documentation source regions. Run `npm run docs:generate` from the repository root
to discover it and create its Markdown guide. Complete the configuration explanations
and run `npm run docs:check`. The registry is generated; do not edit it manually.
Attach author metadata with `createMyPreset.author = 'github-user'`.

Add a scene preset by creating a loader in `src/presets/scenes`, then
registering it in `src/presets/scenes/index.js`.

Scene loaders can return a cleanup function:

```js
export default function createScene(scene) {
  // Add lights, meshes, physics worlds, helpers, etc.

  return () => {
    // Remove scene objects and dispose resources.
  };
}

createScene.author = 'github-user';
```

## License

MIT

## Shared examples and visual validation

Particle factories live in the root `examples/` directory. The demo consumes its generated
registry through the existing preset import path, preserving GUI metadata and code generation.
Scene presets and assets remain under `src/presets/scenes` and `src/assets`.

See [contributing](../../apps/docs/contributing.md) for adding metadata and source regions,
authoring explanations, and generating documentation. From the repository root, build packages
then run `npm run preview -- --example fire --backend webgl` (or `webgpu`). Preview output
contains canvas PNGs, a contact sheet, and diagnostic metadata. `--scene` selects a demo scene.


## Previewing with documentation

Run `npm run site:build` from the repository root to produce one `dist` containing
the demo at `/` and VitePress at `/docs/`. `npm run site:preview` serves both on port
4173 and accepts `/docs` and `/docs/`.
