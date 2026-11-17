import {
  NoopRenderer,
  pairBenchmarkCases,
  createMilestoneGPUModules,
  createNativeBuiltInModules,
} from './benchmark.utils.js';

export default {
  id: 'milestone1',
  name: 'milestone1 workloads',
  feature: 'modules',
  runtime: 'browser',
  backends: ['cpu', 'gpu'],
  readbackRate: 0,
  createCases(_context) {
    const particleCounts = [1_000, 10_000, 100_000];
    const moduleCounts = [1, 5, 10, 20];
    return pairBenchmarkCases([
      ...particleCounts.flatMap(particleCount =>
        moduleCounts.map(moduleCount => ({
          name: `Milestone 1 ${particleCount.toLocaleString()} particles ${moduleCount} modules`,
          particleCount,
          requireGPU: true,
          create: () => ({
            gpuProcessing: true,
            maxParticles: particleCount,
            renderer: new NoopRenderer(),
            modules: createMilestoneGPUModules(moduleCount),
          }),
        })),
      ),
      {
        name: 'Milestone 1 all built-in modules',
        particleCount: 1_000,
        requireGPU: true,
        create: () => ({
          gpuProcessing: true,
          maxParticles: 1_000,
          renderer: new NoopRenderer(),
          modules: createNativeBuiltInModules(),
        }),
      },
    ]);
  },
};
