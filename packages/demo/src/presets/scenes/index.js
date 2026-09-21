import loadCheckerboard from './checkerboard';
import loadColorLights from './colorLights';
import loadHdri from './hdri';
import shanghaiBund from '../../assets/images/shanghai_bund_1k.hdr?url';
import ferndaleStudio from '../../assets/images/ferndale_studio_11_1k.hdr?url';
import createCollisionTest from './collisionTest';
import createAmmoCollisionTest from './collisionAmmo';
import createRapierCollisionTest from './collisionRapier';
import createJoltCollisionTest from './collisionJolt';
import createWind from './wind';
import createVortex from './vortex';
import createRepulsorAttractor from './repulsor';
import createSimulationSpace from './simulationSpace';
import loadCornellBox from './cornellBox';


const scenePresets = {
  Checkerboard: loadCheckerboard,
  'Cornell Box': loadCornellBox,
  'Shanghai Bund HDRI': loadHdri(shanghaiBund),
  'Ferndale Studio HDRI': loadHdri(ferndaleStudio),
  'Color Lights': loadColorLights,
  'Collision (builtin/Octree)': createCollisionTest,
  'Collision (Ammo)': createAmmoCollisionTest,
  'Collision (Rapier)': createRapierCollisionTest,
  'Collision (Jolt)': createJoltCollisionTest,
  'Wind': createWind,
  'Repulsor / Attractor': createRepulsorAttractor,
  'Vortex': createVortex,
  'World Simulation Space': createSimulationSpace,
};

export default scenePresets;
