import { Emitter } from '@rzmps/rzmps';
import snowPreset from 'examples/presets/snow.js';
import { NoopRenderer, configureHierarchyGPU } from './benchmark.utils.js';

export default {
  id: 'runtime-config',
  name: 'runtime-config workloads',
  feature: 'runtime/config',
  runtime: 'browser',
  backends: ['cpu', 'gpu'],
  readbackRate: 0,
  createCases(_context) {
    return [
      {
        name: 'Runtime GPU parameter synchronization',
        benchmarkMode: 'gpu',
        particleCount: 0,
        requireGPU: true,
        create: () => ({
          gpuProcessing: true,
          initialParticleCount: 0,
          maxParticles: 512,
          renderer: new NoopRenderer(),
          emitters: [
            new Emitter({
              rate: 40,
              rateOverDistance: 1,
              bursts: [{ time: 0.1, count: 2 }],
              initialValues: { lifetime: 2 },
            }),
          ],
        }),
        beforeUpdate: system => {
          const emitter = system.emitters[0];
          if (!system.__rzmpsRuntimeBaseline && system.gpuSimulation._gpuEmissionPrepareComputeCache) {
            system.__rzmpsRuntimeBaseline = {
              ...system.gpuConfigurationStats,
              node: system.gpuSimulation._gpuEmissionPrepareComputeCache.nodes[0],
            };
            emitter.rate = 80;
            emitter.rateOverDistance = 3;
            emitter.bursts[0].time = 0.2;
            system.duration = 20;
            system.gravity.set(1, 2, 3);
            return;
          }

          if (system.__rzmpsRuntimeBaseline && !system.__rzmpsRuntimeNumericVerified) {
            const baseline = system.__rzmpsRuntimeBaseline;
            const current = system.gpuConfigurationStats;
            if (current.pipelineBuilds !== baseline.pipelineBuilds) {
              throw new Error('Numeric runtime parameters rebuilt a GPU pipeline.');
            }
            if (current.parameterUploads <= baseline.parameterUploads) {
              throw new Error('Numeric runtime parameters were not uploaded.');
            }
            if (system.gpuSimulation._gpuEmissionPrepareComputeCache.nodes[0] !== baseline.node) {
              throw new Error('Numeric emitter parameters replaced the emission graph.');
            }
            system.__rzmpsRuntimeNumericVerified = true;
            emitter.rate = time => 20 + time * 20;
            return;
          }

          if (system.__rzmpsRuntimeNumericVerified && !system.__rzmpsRuntimeStructuralVerified) {
            const baseline = system.__rzmpsRuntimeBaseline;
            if (system.gpuConfigurationStats.pipelineBuilds <= baseline.pipelineBuilds) return;
            if (system.gpuSimulation._gpuEmissionPrepareComputeCache.nodes[0] === baseline.node) {
              throw new Error('Structural emitter change retained the stale emission graph.');
            }
            system.__rzmpsRuntimeStructuralVerified = true;
          }
        },
        validate: system => {
          if (!system.__rzmpsRuntimeNumericVerified || !system.__rzmpsRuntimeStructuralVerified) {
            throw new Error('Runtime configuration synchronization did not complete.');
          }
        },
      },
      {
        name: 'Snow CPU/GPU reset isolation',
        benchmarkMode: 'mixed',
        particleCount: 0,
        requireGPU: false,
        minimumDurationMs: 3600,
        createSystem: async () => {
          const system = await snowPreset();
          configureHierarchyGPU(system, true);
          return system;
        },
        beforeUpdate: (system, elapsed) => {
          if (system.isGPUProcessingActive && !system.__rzmpsSnowSwitchedToCPU && elapsed > 350) {
            system.gpuProcessing = false;
            system.__rzmpsSnowSwitchedToCPU = true;
            return;
          }
          if (
            system.__rzmpsSnowSwitchedToCPU &&
            !system.isGPUProcessingActive &&
            !system.__rzmpsSnowSwitchedBack &&
            elapsed > 1500
          ) {
            system.gpuProcessing = true;
            system.__rzmpsSnowSwitchedBack = true;
            return;
          }
          if (system.__rzmpsSnowSwitchedBack && system.isGPUProcessingActive && elapsed > 2200) {
            // Chromium may cancel a map while the reset's retired GPU resources are released.
            // Leave an empty observation unset so the benchmark retries it on the next frame.
            if (!system.__rzmpsSnowReadback && !system.__rzmpsSnowReadbackPromise) {
              system.__rzmpsSnowReadbackPromise = system
                .selectiveReadback(32)
                .then(results => {
                  if (results.length > 0) system.__rzmpsSnowReadback = results;
                })
                .finally(() => {
                  system.__rzmpsSnowReadbackPromise = undefined;
                });
            }
            const renderBuffer = system.gpuSimulation._gpuRenderOutputBuffers;
            if (
              renderBuffer &&
              !system.__rzmpsSnowRenderReadback &&
              !system.__rzmpsSnowRenderReadbackPromise &&
              typeof system.sceneRenderer.getArrayBufferAsync === 'function'
            ) {
              system.__rzmpsSnowRenderReadbackPromise = Promise.all([
                system.sceneRenderer.getArrayBufferAsync(renderBuffer.attributes.floatData),
                system.sceneRenderer.getArrayBufferAsync(renderBuffer.attributes.uintData),
              ])
                .then(([floatBuffer, uintBuffer]) => {
                  system.__rzmpsSnowRenderReadback = {
                    floats: new Float32Array(floatBuffer),
                    uints: new Uint32Array(uintBuffer),
                    count: renderBuffer.count,
                  };
                })
                .catch(error => {
                  if (error?.name !== 'AbortError') throw error;
                })
                .finally(() => {
                  system.__rzmpsSnowRenderReadbackPromise = undefined;
                });
            }
          }
        },
        validate: system => {
          const renderer = system.renderers[0];
          const expectedBuffer = system.gpuSimulation._gpuRenderOutputBuffers ?? system.gpuSimulation._gpuBuffers;
          if (!system.__rzmpsSnowSwitchedBack || !system.isGPUProcessingActive) {
            throw new Error('Snow did not return to GPU processing after reset.');
          }
          if (!expectedBuffer || renderer.webgpuGPUMaterialBuffer !== expectedBuffer) {
            throw new Error('Snow renderer retained a stale pre-reset GPU buffer.');
          }
          const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
          const matrices = renderer.webgpuMesh.instanceMatrix.array;
          const matrixCount = Math.min(renderer.webgpuMesh.count, 256);
          for (let instance = 0; instance < matrixCount; instance += 1) {
            const offset = instance * 16;
            if (identity.some((value, index) => Math.abs(matrices[offset + index] - value) > 0.0001)) {
              throw new Error(
                `Snow GPU rendering retained a CPU transform at instance ${instance}: ` +
                  `${JSON.stringify([...matrices.slice(offset, offset + 16)])}.`,
              );
            }
          }
          const samples = system.__rzmpsSnowReadback;
          if (!samples?.length) throw new Error('Snow post-switch GPU readback did not complete.');
          const malformed = samples.filter(
            ({ particle }) =>
              Math.abs(particle.scale.x - 0.25) > 0.001 ||
              Math.abs(particle.scale.y - 0.25) > 0.001 ||
              Math.abs(particle.scale.z - 0.25) > 0.001,
          );
          if (malformed.length > 0) {
            throw new Error(
              `Snow post-switch GPU scale was corrupted for ${malformed.length}/${samples.length} samples.`,
            );
          }
          const rendered = system.__rzmpsSnowRenderReadback;
          if (!rendered) throw new Error('Snow render-output buffer readback did not complete.');
          let renderedSamples = 0;
          let malformedRenderedSamples = 0;
          for (let slot = 0; slot < rendered.count && renderedSamples < 32; slot += 1) {
            if (rendered.uints[slot * 4] === 0) continue;
            renderedSamples += 1;
            const scaleOffset = slot * 16 + 8;
            if (
              Math.abs(rendered.floats[scaleOffset] - 0.25) > 0.001 ||
              Math.abs(rendered.floats[scaleOffset + 1] - 0.25) > 0.001 ||
              Math.abs(rendered.floats[scaleOffset + 2] - 0.25) > 0.001
            )
              malformedRenderedSamples += 1;
          }
          if (renderedSamples === 0 || malformedRenderedSamples > 0) {
            throw new Error(
              `Snow render output contained ${malformedRenderedSamples}/${renderedSamples} malformed scales.`,
            );
          }
        },
      },
    ];
  },
};
