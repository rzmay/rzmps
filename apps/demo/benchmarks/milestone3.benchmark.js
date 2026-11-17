import * as THREE from 'three';
import { ParticleForceField } from '@rzmps/rzmps';
import { NoopRenderer, pairBenchmarkCases, createMilestoneGPUModules } from './benchmark.utils.js';

export default {
  id: 'milestone3',
  name: 'milestone3 workloads',
  feature: 'spatial/forces',
  runtime: 'browser',
  backends: ['cpu', 'gpu'],
  readbackRate: 0,
  createCases(_context) {
    const forceFields = Array.from({ length: 128 }, (_unused, index) =>
      ParticleForceField.Sphere(
        {
          position: new THREE.Vector3((index % 16) * 0.45 - 3.4, Math.floor(index / 16) * 0.45 - 1.6, 0),
          direction: new THREE.Vector3((index % 3) * 0.01, 0.02, 0),
          gravity: index % 5 === 0 ? 0.03 : 0,
          multiplier: 0.5 + (index % 7) * 0.1,
        },
        0.65,
        8,
        4,
      ),
    );
    return pairBenchmarkCases([
      {
        name: 'Milestone 3 128 force fields',
        particleCount: 10_000,
        requireGPU: true,
        create: () => ({
          gpuProcessing: true,
          renderer: new NoopRenderer(),
          modules: createMilestoneGPUModules(1),
          spatialEffects: forceFields,
        }),
        beforeUpdate: (system, elapsed) => {
          const effect = system.spatialEffects[0];
          effect.position.x = Math.sin(elapsed / 500) * 2;
          effect.scale.setScalar(0.75 + Math.sin(elapsed / 700) * 0.2);
          effect.visible = Math.floor(elapsed / 250) % 2 === 0;
          if (elapsed >= 500 && !system.__rzmpsAddedSpatialInstance) {
            system.addSpatialEffect(
              ParticleForceField.Sphere(
                {
                  position: new THREE.Vector3(0, 0, 0),
                  direction: new THREE.Vector3(0, 0.02, 0),
                  multiplier: 0.75,
                },
                0.65,
                8,
                4,
              ),
            );
            system.__rzmpsAddedSpatialInstance = true;
          }
          if (system.gpuSimulation._gpuSpatialRegistry && system.__rzmpsSpatialVersion === undefined) {
            system.__rzmpsSpatialVersion = system.gpuSimulation._gpuSpatialRegistry.version;
          }
        },
        validate: (system, mode) => {
          if (mode === 'cpu') return;
          if (system.gpuSpatialStats.batchableEffects !== 129) {
            throw new Error('Milestone 3 did not register all batchable force fields.');
          }
          if (system.gpuSpatialStats.implementationTypes !== 1) {
            throw new Error('Milestone 3 expanded one force-field implementation into multiple types.');
          }
          if (system.gpuSimulation._gpuSpatialRegistry?.version !== system.__rzmpsSpatialVersion) {
            throw new Error('Milestone 3 replaced GPU resources while adding an existing effect type.');
          }
          if (system.__rzmpsSimulationNodeBuilds !== 1) {
            throw new Error(`Milestone 3 rebuilt its simulation shader ${system.__rzmpsSimulationNodeBuilds} times.`);
          }
        },
      },
    ]);
  },
};
