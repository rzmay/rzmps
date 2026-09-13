# RZMPS Demo

Interactive browser demo for
[RZMPS](https://www.npmjs.com/package/rzmps), the Robert May Particle System for
[Three.js](https://threejs.org/).

| Resource | Link |
| --- | --- |
| Live demo | [rzmps.rzmay.com](https://rzmps.rzmay.com) |
| npm package | [npmjs.com/package/rzmps](https://www.npmjs.com/package/rzmps) |
| GitHub repo | [github.com/rzmay/rzmps](https://github.com/rzmay/rzmps) |

This app is the development playground and showcase for the RZMPS package. It
uses React, React Three Fiber, Parcel, lil-gui, and the local monorepo packages
for `rzmps` and the optional physics integrations.

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

## Demo UI

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

The generated code panel is intended as a quick way to inspect how the current
particle system is configured.

## Local Development

From the repo root:

```bash
npm install
```

Build the local RZMPS packages before running the demo:

```bash
npm run build --workspace packages/rzmps
npm run build --workspace @rzmps/rapier
npm run build --workspace @rzmps/jolt
npm run build --workspace @rzmps/ammo
```

Start the demo:

```bash
npm start --workspace packages/demo
```

Parcel prints the local URL, usually:

```txt
http://localhost:1234
```

## Building

Build the demo from the repo root:

```bash
npm run build --workspace packages/demo
```

The static output is written to:

```txt
packages/demo/dist
```

The demo build script currently uses:

```bash
parcel build --no-optimize --no-scope-hoist
```

This keeps constructor names readable in the browser editor and generated-code
view.

## Monorepo Package Notes

The demo imports `rzmps`, `@rzmps/rapier`, `@rzmps/jolt`, and `@rzmps/ammo` as npm
workspace packages. Until the packages are published, production builds should
build those workspaces from the monorepo before building the demo.

The publishable packages each have a `prepack` script, so `npm pack` and
`npm publish` build their `build/**/*` output automatically. The demo itself is
not published to npm.

## Render Deployment

Use a Render Static Site and leave the root directory set to the repository
root. The demo needs access to sibling workspace packages during install and
build.

Recommended Render settings:

```txt
Service type: Static Site
Root Directory: repo root / blank
Build Command: npm install && npm run build --workspace packages/rzmps && npm run build --workspace @rzmps/rapier && npm run build --workspace @rzmps/jolt && npm run build --workspace @rzmps/ammo && npm run build --workspace packages/demo
Publish Directory: packages/demo/dist
```

Equivalent `render.yaml`:

```yaml
services:
  - type: web
    runtime: static
    name: rzmps-demo
    buildCommand: npm install && npm run build --workspace packages/rzmps && npm run build --workspace @rzmps/rapier && npm run build --workspace @rzmps/jolt && npm run build --workspace @rzmps/ammo && npm run build --workspace packages/demo
    staticPublishPath: packages/demo/dist
```

## Project Structure

```txt
packages/demo
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

- `src/components/ParticleSystemDisplay.js`: loads the active particle preset
  and updates the particle system each frame.
- `src/gui/ParticleSystemGUI.js`: editor controls, preset switching, and code
  serialization.
- `src/presets/particles`: particle system examples.
- `src/presets/scenes`: scene setup examples, including physics backends.

## Adding Presets

Add a particle preset by creating a factory in `src/presets/particles`, then
registering it in `src/presets/particles/index.js`.

```js
const particlePresets = {
  Fire: createFire,
  "My Preset": createMyPreset,
};
```

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
```

## License

MIT
