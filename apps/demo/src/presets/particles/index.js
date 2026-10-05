import createAdditiveSmoke from './additiveSmoke';
import createBubbles from './bubbles';
import createBoids from './boids';
import createCollision from './collision';
import createCollisionSubEmitters from './collisionSubEmitters';
import createCubes from './cubes';
import createDopplerBullet from './dopplerBullet';
import createFire from './fire';
import createFireball from './fireball';
import createFireworks from './fireworks';
import createStylizedDepth from './stylizedDepth';
import createLODStress from './lodStress';
import createParticleTrail from './particleTrail';
import createRibbonTrail from './ribbonTrail';
import createSmoke from './smoke';
import createSnow from './snow';
import createSpheres from './spheres';
import createSuzanne from './suzanne';
import createSuzannes from './suzanneInstances';
import createTags from './tags';

const SOURCE_ROOT = 'https://github.com/rzmay/rzmps/blob/main/apps/demo/src/presets/particles';

function withMetadata(factory, fileName) {
  factory.sourceUrl = `${SOURCE_ROOT}/${fileName}`;
  return factory;
}

const particlePresets = {
  Fire: withMetadata(createFire, 'fire.js'),
  Fireball: withMetadata(createFireball, 'fireball.js'),
  Smoke: withMetadata(createSmoke, 'smoke.js'),
  "Additive Smoke": withMetadata(createAdditiveSmoke, 'additiveSmoke.js'),
  Snow: withMetadata(createSnow, 'snow.js'),
  Suzanne: withMetadata(createSuzanne, 'suzanne.js'),
  Spheres: withMetadata(createSpheres, 'spheres.js'),
  "Cube Instances": withMetadata(createCubes, 'cubes.js'),
  "Suzanne Instances": withMetadata(createSuzannes, 'suzanneInstances.js'),
  "Stylized Depth": withMetadata(createStylizedDepth, 'stylizedDepth.js'),
  "Doppler Bullet": withMetadata(createDopplerBullet, 'dopplerBullet.js'),
  "LOD Stress Test": withMetadata(createLODStress, 'lodStress.js'),
  "Particle Trail": withMetadata(createParticleTrail, 'particleTrail.js'),
  "Ribbon Trail": withMetadata(createRibbonTrail, 'ribbonTrail.js'),
  Collision: withMetadata(createCollision, 'collision.js'),
  "Metal Balls": withMetadata(createCollisionSubEmitters, 'collisionSubEmitters.js'),
  "Bubbles": withMetadata(createBubbles, 'bubbles.js'),
  "Fireworks": withMetadata(createFireworks, 'fireworks.js'),
  "Cubes and Spheres": withMetadata(createTags, 'tags.js'),
  "Boids": withMetadata(createBoids, 'boids.js'),
};

export default particlePresets;
