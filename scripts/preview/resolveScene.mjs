/** An explicit CLI scene overrides the example's imported factory; omission uses metadata. */
export function resolveScene(explicit, preferred, scenes) {
  const entry = explicit ? scenes[explicit] : preferred;
  const factory = typeof entry === 'function' ? entry : entry?.create;
  if (explicit && !factory) throw new Error(`Unknown scene ${explicit}`);
  if (entry != null && typeof factory !== 'function') {
    throw new Error('previewSettings.scene must be an imported scene factory');
  }
  return factory ?? null;
}
