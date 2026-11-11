import * as THREE from 'three';
import { Collision, EmissionShape, GasSimulation } from '@rzmps/rzmps';
import createGasVolume from './gasVolume.js';

export default async function createSteamBurst() {
  // Niagara Fluids' burst workflow, restyled as a brief pressure release rather than colored fire.
  const system = await createGasVolume({
    densityDissipation: 3,
    colorDissipation: 3,
    temperatureDissipation: 1.8,
    velocityDissipation: 0.5,
    buoyancy: 3.5,
    weight: 0,
    sourceTemperature: 1.3,
    scalarDiffusion: 0.1,
    turbulenceStrength: 1.25,
    vorticityStrength: 3,
    temperatureColor: undefined,
    temperatureOverLifetime: time => 1 - time,
  });
  system.name = 'Steam Burst';
  system.duration = 2;
  const emitter = system.emitters[0];
  emitter.source = EmissionShape.Sphere(0.22, 12, 8);
  emitter.rate = 0;
  emitter.bursts = [{ time: 0, count: 600 }];
  Object.assign(emitter.initialValues, {
    lifetime: 0.4,
    scale: new THREE.Vector3(0.3, 0.3, 0.3),
    color: new THREE.Color('#edf4f5'),
    alpha: 0.65,
    velocity: new THREE.Vector3(0, 2.8, 0),
  });
  emitter.radialSpeed = 1.8;
  system.modules = system.modules.filter(module => module instanceof GasSimulation || module instanceof Collision);
  Object.assign(system.renderers[0], {
    opacity: 0.5, threshold: 0.035, range: 0.03,
    noiseStrength: 1.2, noiseContrast: 1.2, noiseFrequency: 2.5, noiseSpeed: 0.8,
  });
  return system;
}

createSteamBurst.author = 'rzmay';

export const metadata = {
  id: 'steamBurst',
  title: 'Steam Burst',
  description: 'A white steam pressure-release puff that expands, rises, and dissipates; inspired by Niagara Fluids.',
  tags: ['gas', 'steam', 'burst', 'webgpu'],
  category: 'effects',
};

createSteamBurst.description = metadata.description;
createSteamBurst.metadata = { ...metadata, author: 'rzmay' };
