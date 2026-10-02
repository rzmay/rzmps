import loadCheckerboard from './checkerboard';
import loadColorLights from './colorLights';
import loadHdri from './hdri';
import shanghaiBund from '../../assets/images/shanghai_bund_1k.hdr?url';
import ferndaleStudio from '../../assets/images/ferndale_studio_11_1k.hdr?url';
import createCollisionTest from './collisionTest';
import createAmmoCollisionTest from './collisionAmmo';
import createRapierCollisionTest from './collisionRapier';
import createJoltCollisionTest from './collisionJolt';
import createKillZoneScene from './killZones';
import createCustomSpatialEffects from './customSpatialEffects';
import createWind from './wind';
import createVortex from './vortex';
import createRepulsorAttractor from './repulsor';
import createSimulationSpace from './simulationSpace';
import loadCornellBox from './cornellBox';
import createLightProbeScene from './lightProbes';

const SOURCE_ROOT = 'https://github.com/rzmay/rzmps/blob/main/packages/demo/src/presets/scenes';

function withMetadata(factory, fileName, author = factory.author) {
  factory.sourceUrl = `${SOURCE_ROOT}/${fileName}`;
  factory.author = author;
  return factory;
}

const scenePresets = {
  Checkerboard: withMetadata(loadCheckerboard, 'checkerboard.js'),
  'Cornell Box': withMetadata(loadCornellBox, 'cornellBox.js'),
  'Light Probe Room': withMetadata(createLightProbeScene, 'lightProbes.js'),
  'Shanghai Bund HDRI': withMetadata(loadHdri(shanghaiBund), 'hdri.js', loadHdri.author),
  'Ferndale Studio HDRI': withMetadata(loadHdri(ferndaleStudio), 'hdri.js', loadHdri.author),
  'Color Lights': withMetadata(loadColorLights, 'colorLights.js'),
  'Collision (builtin/Octree)': withMetadata(createCollisionTest, 'collisionTest.js'),
  'Collision (Ammo)': withMetadata(createAmmoCollisionTest, 'collisionAmmo.js'),
  'Collision (Rapier)': withMetadata(createRapierCollisionTest, 'collisionRapier.js'),
  'Collision (Jolt)': withMetadata(createJoltCollisionTest, 'collisionJolt.js'),
  'Kill Zones': withMetadata(createKillZoneScene, 'killZones.js'),
  'Custom Spatial Effects': withMetadata(createCustomSpatialEffects, 'customSpatialEffects.js'),
  'Wind': withMetadata(createWind, 'wind.js'),
  'Repulsor / Attractor': withMetadata(createRepulsorAttractor, 'repulsor.js'),
  'Vortex': withMetadata(createVortex, 'vortex.js'),
  'World Simulation Space': withMetadata(createSimulationSpace, 'simulationSpace.js'),
};

export default scenePresets;
