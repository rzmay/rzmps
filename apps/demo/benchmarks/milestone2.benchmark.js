import { OrientToDirection, ParticleSystem } from '@rzmps/rzmps';
import { NoopRenderer, pairBenchmarkCases, createMilestoneGPUModules } from './benchmark.utils.js';

export default {
  id: 'milestone2',
  name: 'milestone2 workloads',
  feature: 'events',
  runtime: 'browser',
  backends: ['cpu', 'gpu'],
  readbackRate: 0,
  createCases(_context) {
    const deathEventCase = (particleCount, expectedDeathEvents, expectOverflow = false) => ({
      name: expectOverflow
        ? `Milestone 2 event overflow ${particleCount.toLocaleString()} deaths`
        : `Milestone 2 death events ${particleCount.toLocaleString()} deaths`,
      particleCount,
      requireGPU: true,
      expectedDeathEvents,
      create: () => ({
        gpuProcessing: true,
        maxParticles: particleCount,
        renderer: new NoopRenderer(),
        modules: [...createMilestoneGPUModules(1), new OrientToDirection()],
      }),
      configure: system => {
        system.particles.forEach(particle => {
          particle.lifetime = 0.01;
        });
        system.__rzmpsBenchmarkDeathEvents = 0;
        system.onDeath(() => {
          system.__rzmpsBenchmarkDeathEvents += 1;
        });
      },
      validate: system => {
        const overflowCount = system.gpuEventStats.overflowCount;
        const minimumOverflow = particleCount - ParticleSystem.Settings.GPU_EVENT_BUFFER_CAPACITY;
        if (expectOverflow && overflowCount < minimumOverflow) {
          throw new Error(`Milestone 2 reported ${overflowCount} overflows; expected at least ${minimumOverflow}.`);
        }
      },
    });
    return pairBenchmarkCases([
      deathEventCase(4096, 4096),
      {
        ...deathEventCase(5000, ParticleSystem.Settings.GPU_EVENT_BUFFER_CAPACITY, true),
        gpuOnly: true,
      },
    ]);
  },
};
