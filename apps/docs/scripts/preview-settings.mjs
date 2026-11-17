/** Shared poster/video resolution and encoding quality; presets own their clip durations. */
export const previewDefaults = Object.freeze({
  backend: 'webgl',
  warmup: 180,
  format: 'mp4',
  duration: 4,
  fps: 60,
  crf: 18,
  width: 1920,
  height: 1080,
  seed: 1,
});

/** Scene factories stay in browser-side metadata; only scalar options cross the CLI boundary. */
export function previewArguments(example, output) {
  const { scene, ...overrides } = example.previewSettings ?? {};
  const settings = { ...previewDefaults, ...overrides, example: example.id, output };
  return Object.entries(settings).flatMap(([key, value]) => [
    '--' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()),
    Array.isArray(value) ? value.join(',') : String(value),
  ]);
}
