import * as THREE from 'three';
import { Emitter, EmissionShape, ParticleSystem, MaxCulling } from '@rzmps/rzmps';
import fireworksPreset from 'examples/presets/fireworks.js';
import { NoopRenderer, pairBenchmarkCases, createMilestoneGPUModules } from './benchmark.utils.js';

export default {
  id: 'milestone4',
  name: 'milestone4 workloads',
  feature: 'lifecycle',
  runtime: 'browser',
  backends: ['cpu', 'gpu'],
  readbackRate: 0,
  createCases(_context) {
    return pairBenchmarkCases([
      {
        name: 'Milestone 4 GPU-native lifecycle and subsystems',
        gpuOnly: true,
        particleCount: 0,
        requireGPU: true,
        create: () => ({
          gpuProcessing: true,
          initialParticleCount: 0,
          maxParticles: 8,
          maxCullingMode: MaxCulling.Old,
          renderer: new NoopRenderer(),
          emitters: [
            new Emitter({
              source: EmissionShape.Sphere(0.05),
              rate: 100,
              tags: ['gpu-parent'],
              initialValues: {
                lifetime: 0.35,
                position: new THREE.Vector3(0.05, 0.1, -0.05),
                velocity: new THREE.Vector3(0, 1, 0),
              },
            }),
          ],
          modules: createMilestoneGPUModules(1),
        }),
        configure: system => {
          system.__rzmpsBenchmarkSpawnEvents = 0;
          system.__rzmpsBenchmarkDeathEvents = 0;
          system.onSpawn(() => {
            system.__rzmpsBenchmarkSpawnEvents += 1;
          });
          system.onDeath(() => {
            system.__rzmpsBenchmarkDeathEvents += 1;
          });
          const smoke = new ParticleSystem({
            gpuProcessing: true,
            maxParticles: 256,
            emitters: [
              new Emitter({
                source: EmissionShape.Sphere(0.02),
                rate: 18,
                rateOverDistance: 2,
                initialValues: { lifetime: 0.5 },
              }),
            ],
            modules: createMilestoneGPUModules(1),
            renderers: [new NoopRenderer()],
          });
          const bursts = new ParticleSystem({
            gpuProcessing: true,
            looping: false,
            duration: 0.5,
            maxParticles: 256,
            emitters: [
              new Emitter({
                source: EmissionShape.Cone(0.05, 0.1),
                rate: 4,
                bursts: [
                  { time: 0, count: 4 },
                  { time: 0.5, count: 2 },
                ],
                initialValues: { lifetime: 0.3 },
              }),
            ],
            modules: createMilestoneGPUModules(1),
            renderers: [new NoopRenderer()],
          });
          const nestedSparks = new ParticleSystem({
            gpuProcessing: true,
            looping: false,
            duration: 0.25,
            maxParticles: 128,
            emitters: [
              new Emitter({
                source: EmissionShape.Sphere(0.01),
                rate: 0,
                bursts: [{ time: 0, count: 2 }],
                initialValues: { lifetime: 0.15 },
              }),
            ],
            modules: createMilestoneGPUModules(1),
            renderers: [new NoopRenderer()],
          });

          system.addSubSystem(smoke, {
            emitContinuous: true,
            emitOnDeath: true,
            inheritLifetime: 0,
            inheritColor: 0,
            inheritScale: 0,
          });
          system.addSubSystem(bursts, {
            emitOnDeath: true,
            inheritLifetime: 0,
            inheritScale: 0,
          });
          bursts.addSubSystem(nestedSparks, { emitOnSpawn: true, inheritLifetime: 0 });
          system.__rzmpsBenchmarkChildren = [smoke, bursts, nestedSparks];
        },
        validate: system => {
          const children = system.__rzmpsBenchmarkChildren ?? [];
          if (system.particles.length !== 0 || children.some(child => child.particles.length !== 0)) {
            throw new Error('Milestone 4 created CPU Particle objects for GPU-native emission.');
          }
          if (!system.gpuSimulation._gpuBuffers || children.some(child => !child.gpuSimulation._gpuBuffers)) {
            throw new Error('Milestone 4 did not initialize every GPU-native particle pool.');
          }
          if (
            !children[0].gpuSimulation._gpuContinuousEmitterInstances ||
            !children[0].gpuSimulation._gpuEventEmitterInstances ||
            !children[1].gpuSimulation._gpuEmissionRuns ||
            !children[2].gpuSimulation._gpuEmissionRuns
          ) {
            throw new Error('Milestone 4 did not initialize mixed contexts and nested persistent event runs.');
          }
          if (system.__rzmpsBenchmarkSpawnEvents <= 0 || system.__rzmpsBenchmarkDeathEvents <= 0) {
            throw new Error('Milestone 4 did not deliver asynchronous GPU spawn/death callbacks.');
          }
        },
      },
      {
        name: 'Milestone 4 actual fireworks',
        particleCount: 0,
        minimumDurationMs: 3500,
        createSystem: () => fireworksPreset(),
        configure: system => {
          system.__rzmpsBenchmarkSpawnEvents = 0;
          system.__rzmpsBenchmarkDeathEvents = 0;
          system.onSpawn(() => {
            system.__rzmpsBenchmarkSpawnEvents += 1;
          });
          system.onDeath(() => {
            system.__rzmpsBenchmarkDeathEvents += 1;
          });
        },
        validate: (system, mode) => {
          if (mode === 'cpu') {
            if (system.isGPUProcessingActive || system.particles.length <= 0) {
              throw new Error('Actual fireworks CPU mode did not remain on CPU or emit rockets.');
            }
            return;
          }
          const children = [...system.subSystems.keys()];
          const smoke = children.find(child => child.name === 'Rocket Smoke');
          const sparkles = children.find(child => child.name === 'Sparkles');
          if (!smoke?.gpuSimulation._gpuContinuousEmitterInstances || !sparkles?.gpuSimulation._gpuEmissionRuns) {
            throw new Error('Actual fireworks did not use GPU smoke contexts and sparkle runs.');
          }
          if (system.particles.length || smoke.particles.length || sparkles.particles.length) {
            throw new Error('Actual fireworks created CPU particles in GPU mode.');
          }
          if (system.__rzmpsBenchmarkSpawnEvents <= 0 || system.__rzmpsBenchmarkDeathEvents <= 0) {
            throw new Error('Actual fireworks did not deliver launch and explosion event callbacks.');
          }
        },
      },
    ]);
  },
};
