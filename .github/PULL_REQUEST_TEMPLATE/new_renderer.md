## Renderer

Name of the new renderer:

## Behavior

What does it render, and when should users choose it?

## Buffer / Upload Strategy

Describe geometry, instancing, typed arrays, resizing, and GPU attribute updates.

## Material / Lighting

Describe supported material options, shadows, light probes, live cubemaps, and
WebGL/WebGPU behavior.

## Documentation

- [ ] Added or updated the relevant section in `README.md`
- [ ] Added or updated the relevant section in `packages/rzmps/README.md`
- [ ] Documented renderer options, material/lighting behavior, and a short usage example

## Screenshot

Add a screenshot, video, or animated GIF showing the renderer in the demo.

## Demo

- [ ] Added or updated a demo preset
- [ ] Added GUI controls when useful

## Verification

- [ ] `npm run build --workspace @rzmps/rzmps`
- [ ] `npm run build --workspace apps/demo`
- [ ] Visual check in WebGL
- [ ] Visual check in WebGPU, if supported
