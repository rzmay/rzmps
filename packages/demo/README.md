# RZMPS Demo

Interactive browser demo for
[RZMPS](https://www.npmjs.com/package/@rzmps/rzmps), the Robert May Particle System for
[Three.js](https://threejs.org/).

| Resource | Link |
| --- | --- |
| Live demo | [rzmps.rzmay.com](https://rzmps.rzmay.com) |
| npm package | [npmjs.com/package/@rzmps/rzmps](https://www.npmjs.com/package/@rzmps/rzmps) |
| GitHub repo | [github.com/rzmay/rzmps](https://github.com/rzmay/rzmps) |

This app is the development playground and showcase for the RZMPS package. It
uses React, React Three Fiber, Parcel, lil-gui, and the local monorepo packages
for `@rzmps/rzmps` and the optional physics integrations.

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

The demo imports `@rzmps/rzmps`, `@rzmps/rapier`, `@rzmps/jolt`, and
`@rzmps/ammo` as npm packages. Local development from the repo root uses npm
workspaces, so those packages resolve to sibling package folders. Production
demo deployments should install from `packages/demo` so npm resolves the
published registry packages instead.

The publishable packages each have a `prepack` script, so `npm pack` and
`npm publish` build their `build/**/*` output automatically. The demo itself is
not published to npm.

## Render Deployment

Use a Render Static Site and set the root directory to `packages/demo`. That
keeps the deployment outside the monorepo workspace install, so npm installs
the published `@rzmps/*` packages from the registry.

Recommended Render settings:

```txt
Service type: Static Site
Root Directory: packages/demo
Build Command: npm install && npm run build
Publish Directory: dist
```

Equivalent `render.yaml`:

```yaml
services:
  - type: web
    runtime: static
    name: rzmps-demo
    rootDir: packages/demo
    buildCommand: npm install && npm run build
    staticPublishPath: dist
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
