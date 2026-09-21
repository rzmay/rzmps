import createAdditiveSmoke from './additiveSmoke';
import createBubbles from './bubbles';
import createCollision from './collision';
import createCollisionSubEmitters from './collisionSubEmitters';
import createCubes from './cubes';
import createFire from './fire';
import createFireball from './fireball';
import createFireworks from './fireworks';
import createParticleTrail from './particleTrail';
import createRibbonTrail from './ribbonTrail';
import createSmoke from './smoke';
import createSnow from './snow';
import createSpheres from './spheres';
import createSuzanne from './suzanne';
import createSuzannes from './suzanneInstances';
import createTags from './tags';

const particlePresets = {
  Fire: createFire,
  Fireball: createFireball,
  Smoke: createSmoke,
  "Additive Smoke": createAdditiveSmoke,
  Snow: createSnow,
  Suzanne: createSuzanne,
  Spheres: createSpheres,
  "Cube Instances": createCubes,
  "Suzanne Instances": createSuzannes,
  "Particle Trail": createParticleTrail,
  "Ribbon Trail": createRibbonTrail,
  Collision: createCollision,
  "Metal Balls": createCollisionSubEmitters,
  "Bubbles (Audio)": createBubbles,
  "Fireworks (Subsystems)": createFireworks,
  "Cubes and Spheres (Tags)": createTags,
};

export default particlePresets;
