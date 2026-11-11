import * as THREE from 'three';
import { Collision, EmissionShape, GasSimulation } from '@rzmps/rzmps';
import createGasVolume from './gasVolume.js';

export default async function createVolumetricSmoke() {
  // Blender's buoyant smoke workflow; the artistic coefficients use this solver's units.
  const system = await createGasVolume({
    densityDissipation: 0.25,
    colorDissipation: 0.25,
    temperatureDissipation: 0.45,
    velocityDissipation: 0.15,
    buoyancy: 2,
    sourceStrength: 5,
    automaticPadding: false,
    weight: 0,
    sourceTemperature: 1.2,
    scalarDiffusion: 0.02,
    vorticityStrength: 3,
    turbulenceStrength: 0.8,
    noiseFrequency: 1.8,
    temperatureColor: undefined,
    temperatureOverLifetime: 1,
    externalForce: new THREE.Vector3(0.12, 0, 0),
  });
  system.name = 'Volumetric Smoke';
  system.duration = 5;
  const emitter = system.emitters[0];
  emitter.source = EmissionShape.Sphere(0.16, 12, 8);
  emitter.rate = 350;
  emitter.radialSpeed = 0.2;
  Object.assign(emitter.initialValues, {
    lifetime: 0.35,
    scale: new THREE.Vector3(0.28, 0.28, 0.28),
    color: new THREE.Color('#555555'),
    alpha: 0.85,
    velocity: new THREE.Vector3(0, 1.5, 0),
  });
  system.modules = system.modules.filter(module => module instanceof GasSimulation || module instanceof Collision);
  Object.assign(system.renderers[0], {
    opacity: 0.75, threshold: 0.025, range: 0.025,
    noiseStrength: 1.3, noiseContrast: 1.3, noiseFrequency: 2, noiseSpeed: 0.5,
  });
  return system;
}

createVolumetricSmoke.author = 'rzmay';

export const metadata = {
  id: 'volumetricSmoke',
  title: 'Volumetric Smoke',
  description: 'A narrow charcoal smoke plume that rises into rolling wisps; inspired by Blender smoke simulations.',
  tags: ['gas', 'smoke', 'plume', 'webgpu'],
  category: 'effects',
};

createVolumetricSmoke.description = metadata.description;
createVolumetricSmoke.metadata = { ...metadata, author: 'rzmay' };
