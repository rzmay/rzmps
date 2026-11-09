import { createRegistry } from './utils/registry.js';

export const examples = createRegistry(
  import.meta.glob(['./presets/*.{js,ts}', '!./presets/index.{js,ts}'], { eager: true, import: 'default' }), 'presets',
);

export default Object.fromEntries(examples.map(entry => [entry.title, entry]));
