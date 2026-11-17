import { If, vec4 } from 'three/tsl';
import { Emitter, EmissionShape, Module, ParticleSystem } from '@rzmps/rzmps';
import { NoopRenderer, pairBenchmarkCases } from './benchmark.utils.js';

export default {
  id: 'emitter-instances',
  name: 'emitter-instances workloads',
  feature: 'emission/instances',
  runtime: 'browser',
  backends: ['cpu', 'gpu'],
  readbackRate: 0,
  createCases(_context) {
    return pairBenchmarkCases(
      [8, 256, 2048].flatMap(count =>
        ['live', 'events'].map(kind => ({
          name: `Emitter instances ${kind} ${count}`,
          particleCount: 0,
          create: () => ({
            initialParticleCount: 0,
            duration: 60,
            maxParticles: count,
            renderer: new NoopRenderer(),
            emitters: [
              new Emitter({
                source: EmissionShape.Sphere(1),
                bursts: { time: 0, count },
                radialSpeed: 0,
                initialValues: { lifetime: 60 },
              }),
            ],
            modules:
              kind === 'events'
                ? [
                    new Module(
                      (particle, dt) => {
                        if (
                          Math.floor(particle.realtime / 750) >
                          Math.floor(Math.max(0, particle.realtime - dt * 1000) / 750)
                        ) {
                          particle.emitEvent('pulse', 1);
                        }
                      },
                      {
                        modifyGPU(particle, dt) {
                          If(
                            particle.realtime
                              .div(750)
                              .floor()
                              .greaterThan(particle.realtime.sub(dt.mul(1000)).max(0).div(750).floor()),
                            () => {
                              particle.emitEvent('pulse', [vec4(1, 0, 0, 0)]);
                            },
                          );
                        },
                      },
                    ),
                  ]
                : [],
          }),
          configure: (system, mode) => {
            system.duration = 60;
            const child = new ParticleSystem({
              gpuProcessing: mode === 'gpu',
              gravityModifier: 0,
              duration: 0.4,
              maxParticles: count * 4,
              emitters: [
                new Emitter({
                  source: EmissionShape.Sphere(0.01),
                  rate: kind === 'live' ? 12 : 0,
                  bursts:
                    kind === 'events'
                      ? [
                          { time: 0, count: 1 },
                          { time: 0.5, count: 1 },
                        ]
                      : [],
                  radialSpeed: 0,
                  initialValues: { lifetime: 0.2 },
                }),
              ],
              renderers: [new NoopRenderer()],
            });
            // Fix output capacity so the comparison measures executions rather than pool growth.
            child.gpuSimulation._getInitialGPUBufferCapacity = () => count * 4;
            system.addSubSystem(child, {
              emitContinuous: kind === 'live',
              onEvent: kind === 'events' ? ['pulse'] : undefined,
              inheritLifetime: 0,
            });
          },
          validate: system => {
            const child = [...system.subSystems.keys()][0];
            if (!system.isGPUProcessingActive && !child.liveParticleCount && kind === 'live') {
              throw new Error('Live instances did not emit.');
            }
            if (
              system.isGPUProcessingActive &&
              (!child.isGPUProcessingActive ||
                system.particles.length ||
                child.particles.length ||
                system.gpuEventStats.readbackCount ||
                child.gpuEventStats.readbackCount)
            ) {
              throw new Error('Emitter instances must stay GPU-native without event readback.');
            }
            const runtime =
              kind === 'live'
                ? child.gpuSimulation._gpuContinuousEmitterInstances
                : child.gpuSimulation._gpuEventEmitterInstances;
            system.__emitterInstanceDiagnostics = {
              childCapacity: child.gpuBufferStats.allocated,
              instanceCapacity: runtime?.capacity ?? 0,
              instanceBufferBytes: runtime
                ? runtime.floatAttribute.array.byteLength +
                  runtime.uintAttribute.array.byteLength +
                  runtime.runtimeCounterAttribute.array.byteLength
                : 0,
              snapshotBufferBytes: child.gpuSimulation._gpuEmissionRuns
                ? child.gpuSimulation._gpuEmissionRuns.snapshots.attributes.floatData.array.byteLength +
                  child.gpuSimulation._gpuEmissionRuns.snapshots.attributes.uintData.array.byteLength
                : 0,
              particleBufferBytes: child.gpuSimulation._gpuBuffers
                ? child.gpuSimulation._gpuBuffers.attributes.floatData.array.byteLength +
                  child.gpuSimulation._gpuBuffers.attributes.uintData.array.byteLength
                : 0,
              childConfiguration: child.gpuConfigurationStats,
              childEvents: child.gpuEventStats,
            };
          },
        })),
      ),
    );
  },
};
