import * as THREE from 'three';
import { GasSimulation } from '@rzmps/rzmps';
import createGasVolume from './gasVolume.js';

export default async function createGasNiagaraBurst() {
  // Rates and temperature buoyancy from Epic's Niagara Fluids Quick Start:
  // https://dev.epicgames.com/documentation/unreal-engine/niagara-fluids-quick-start-guide-for-unreal-engine
  const system = await createGasVolume({
    densityDissipation: 3,
    colorDissipation: 3,
    temperatureDissipation: 1.5,
    velocityDissipation: 0.8,
    buoyancy: 3.5,
    scalarDiffusion: 0,
    turbulenceStrength: 0,
    temperatureOverLifetime: 1,
    bounds: new THREE.Box3(new THREE.Vector3(-3, -1, -3), new THREE.Vector3(3, 4, 3)),
    automaticPadding: false,
  });
  system.name = 'Gas Niagara Burst';
  system.duration = 0.2;
  system.looping = false;
  const emitter = system.emitters[0];
  emitter.rate = 800;
  emitter.radialSpeed = 1.8;
  emitter.initialValues.lifetime = 0.25;
  emitter.initialValues.velocity = new THREE.Vector3(0, 0.8, 0);
  system.modules = system.modules.filter((module) => module instanceof GasSimulation);
  return system;
}

createGasNiagaraBurst.author = 'rzmay';

export const metadata = {
  id: 'gasNiagaraBurst',
  title: 'Gas Niagara Burst',
  description: "A short gas burst using the dissipation and buoyancy values from Epic's Niagara Fluids Quick Start.",
  tags: ['gas', 'reference', 'webgpu'],
  category: 'effects',
};

createGasNiagaraBurst.description = metadata.description;
