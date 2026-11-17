import dopplerBulletPreset from 'examples/presets/dopplerBullet.js';
import { pairBenchmarkCases } from './benchmark.utils.js';

export default {
  id: 'doppler',
  name: 'doppler workloads',
  feature: 'examples/doppler',
  runtime: 'browser',
  backends: ['cpu', 'gpu'],
  readbackRate: 0,
  createCases(_context) {
    return pairBenchmarkCases([
      {
        name: 'Doppler Bullet offset emission',
        particleCount: 0,
        minimumDurationMs: 3000,
        createSystem: () => dopplerBulletPreset(),
        configure: system => {
          system.__rzmpsBenchmarkSpawnPositions = [];
          system.onSpawn(particle => {
            system.__rzmpsBenchmarkSpawnPositions.push(particle.position.clone());
          });
        },
        validate: (system, mode) => {
          const spawn = system.__rzmpsBenchmarkSpawnPositions[0];
          if (!spawn || spawn.z < 25) {
            throw new Error(
              'Doppler Bullet [' +
                `${mode.toUpperCase()}` +
                '] spawned at ' +
                `${spawn?.toArray().join(', ') ?? 'no position'}` +
                '; expected the offset cone near z=34.',
            );
          }
        },
      },
    ]);
  },
};
