import { createRegistry } from '../utils/registry.js';

export const scenes = createRegistry(
  import.meta.glob(['./*.{js,ts}', '!./index.{js,ts}'], { eager: true, import: 'default' }), 'scenes',
).sort((a, b) => Number(['fluidTeapot', 'movingColliders', 'gasSpatialEffects'].includes(a.id))
  - Number(['fluidTeapot', 'movingColliders', 'gasSpatialEffects'].includes(b.id)));

export default Object.fromEntries(scenes.map(entry => [entry.title, entry]));
