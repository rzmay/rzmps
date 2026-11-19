import { profileFluidStages, profileMethod } from './fluidProfiling.utils.js';

export const liquidStageNames = [
  'particle spatial index', 'P2G transfer', 'boundary/collider classification', 'pressure topology',
  'pressure solve', 'G2P transfer', 'particle density/separation', 'particle collision',
  'surface field construction', 'surface extraction', 'surface attribute reconstruction',
  'surface rendering', 'secondary-particle/spray work', 'foam surface query', 'foam attachment', 'foam rendering',
];

export function liquidStage(name, surface = false) {
  if (surface) {
    if (name === 'particleSpatialIndex') return 'particle spatial index';
    if (name === 'surfaceExtraction') return 'surface extraction';
    if (['meshUpdate', 'surfaceVorticity', 'surfaceSmoothing'].includes(name))
      return 'surface attribute reconstruction';
    return 'surface field construction';
  }
  return ({ particleSpatialIndex: 'particle spatial index', particleToGrid: 'P2G transfer',
    boundaryUpdate: 'boundary/collider classification', pressureTopology: 'pressure topology',
    pressureSolve: 'pressure solve', pressureSweeps: 'pressure solve', pressureMultigrid: 'pressure solve',
    gridToParticle: 'G2P transfer', separation: 'particle density/separation', particleCollision: 'particle collision',
  })[name] ?? name;
}

export function profileLiquidStages(system, renderer, state) {
  const { flip, surface } = system.__liquidFixture;
  const restorations = [profileFluidStages(renderer,
    [[flip, name => `liquid/${liquidStage(name)}`], [surface, name => {
      const detail = state.detailedSurface ? `/${name}` : '';
      return `liquid/${liquidStage(name, true)}${detail}`;
    }]], state)];
  restorations.push(profileMethod(system.gpuSimulation, '_computeGPUSimulationPhase', state,
    'liquid/particle collision'));
  const index = flip.getParticleSpatialGrid(system);
  if (index) restorations.push(profileMethod(index, 'rebuild', state, 'liquid/particle spatial index'));
  restorations.push(profileMethod(system, '_updateSubSystems', state, 'liquid/secondary-particle/spray work'));
  for (const method of ['_computeGPUContinuousSubSystemEmissionPhase', '_computeGPUEventSubSystemEmissionPhase'])
    restorations.push(profileMethod(system.gpuSimulation, method, state, 'liquid/secondary-particle/spray work'));
  for (const child of system.subSystems.keys()) if (child.name === 'Liquid Foam') {
    restorations.push(profileMethod(child.gpuSimulation, '_computeGPUSimulationPhase', state,
      'foam/simulation-and-attachment'));
  }
  return () => restorations.reverse().forEach(restore => restore());
}
