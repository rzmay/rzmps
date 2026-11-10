import { createRegistry } from '../utils/registry.js';

export const scenes = createRegistry(
  import.meta.glob(['./*.{js,ts}', '!./index.{js,ts}'], { eager: true, import: 'default' }), 'scenes',
).sort((a, b) => Number(['fluidTeapot', 'gasFlow'].includes(a.id))
  - Number(['fluidTeapot', 'gasFlow'].includes(b.id)));

export default Object.fromEntries(scenes.map(entry => [entry.title, entry]));
