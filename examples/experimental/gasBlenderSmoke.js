import * as THREE from 'three';
import { GasSimulation } from '@rzmps/rzmps';
import createGasVolume from './gasVolume.js';

export default async function createGasBlenderSmoke() {
  // Blender's smoke study compares vorticity 0 and 0.2; Dissolve is optional:
  // https://docs.blender.org/manual/en/latest/physics/fluid/type/domain/settings.html
  // This uses RZMPS's turbulence control as an approximation, not Mantaflow's units.
  const system = await createGasVolume({
    densityDissipation: 0,
    colorDissipation: 0,
    temperatureDissipation: 0.6,
    velocityDissipation: 0.1,
    buoyancy: 1,
    weight: 0,
    scalarDiffusion: 0,
    vorticityStrength: 0.2,
    temperatureColor: undefined,
    temperatureOverLifetime: 1,
    bounds: new THREE.Box3(new THREE.Vector3(-3, -1, -3), new THREE.Vector3(3, 4, 3)),
    automaticPadding: false,
  });
  system.name = 'Gas Blender Smoke';
  system.duration = 0.2;
  system.looping = false;
  const emitter = system.emitters[0];
  emitter.rate = 800;
  emitter.radialSpeed = 0.35;
  emitter.initialValues.lifetime = 0.25;
  emitter.initialValues.color = new THREE.Color('#bfc7cf');
  emitter.initialValues.velocity = new THREE.Vector3(0, 0.8, 0);
  system.modules = system.modules.filter((module) => module instanceof GasSimulation);
  return system;
}

createGasBlenderSmoke.author = 'rzmay';

export const metadata = {
  id: 'gasBlenderSmoke',
  title: 'Gas Blender Smoke',
  description: 'A Blender-inspired smoke study with density dissolve disabled and gentle turbulence.',
  tags: ['gas', 'reference', 'webgpu'],
  category: 'effects',
};

createGasBlenderSmoke.description = metadata.description;
