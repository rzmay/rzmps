/** Resolve shareable demo routes and legacy query links without executing factories. */
export function resolveDemoSelection(url, examples, scenes) {
  const requested = url.searchParams.get('preset');
  const routeId = url.pathname.match(/^\/example\/([\w-]+)(?:\.html|\/index\.html)?\/?$/)?.[1];
  const example = examples.find(entry => entry.title === requested)
    ?? examples.find(entry => entry.id === routeId)
    ?? examples.find(entry => entry.title === 'Fire') ?? examples[0];
  const preferred = example.previewSettings?.scene;
  const preferredName = Object.keys(scenes).find(name => (scenes[name]?.create ?? scenes[name]) === preferred);
  const explicitScene = url.searchParams.get('scene');
  const explicitBackend = url.searchParams.get('renderer');
  return {
    preset: example.title,
    scene: Object.hasOwn(scenes, explicitScene) ? explicitScene : preferredName ?? 'Checkerboard',
    backend: ['webgl','webgpu'].includes(explicitBackend) ? explicitBackend
      : example.previewSettings?.backend ?? 'webgl',
  };
}
