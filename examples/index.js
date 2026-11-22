import { createRegistry } from './utils/registry.js';

export const examples = createRegistry(
  import.meta.glob(['./presets/*.{js,ts}', '!./presets/index.{js,ts}'], { eager: true, import: 'default' }), 'presets',
).sort((a, b) => Number(a.id === 'flipFluid') - Number(b.id === 'flipFluid'));

export default Object.fromEntries(examples.map(entry => [entry.title, entry]));
