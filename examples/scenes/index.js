import { createRegistry } from '../utils/registry.js';

export const scenes = createRegistry(
  import.meta.glob(['./*.{js,ts}', '!./index.{js,ts}'], { eager: true, import: 'default' }), 'scenes',
);

export default Object.fromEntries(scenes.map(entry => [entry.title, entry]));
