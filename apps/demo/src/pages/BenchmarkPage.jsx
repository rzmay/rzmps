/* eslint-disable react/no-unknown-property */
import React, { useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  AmbientLightNode,
  DirectionalLightNode,
  HemisphereLightNode,
  PointLightNode,
  RectAreaLightNode,
  SpotLightNode,
  WebGPURenderer,
} from 'three/webgpu';
import { RectAreaLightTexturesLib } from 'three/examples/jsm/lights/RectAreaLightTexturesLib.js';
import {
  ColorOverLifetime,
  ColorByDepth,
  ColorBySize,
  ColorBySpeed,
  Collision,
  DistortionByDepth,
  DistortionBySize,
  DistortionBySpeed,
  DistortionOverLifetime,
  Emitter,
  EmissionShape,
  ForceOverLifetime,
  KillZone,
  LimitVelocityOverLifetime,
  MassByDepth,
  MassBySize,
  MassOverLifetime,
  MeshRenderer,
  NoiseModule,
  OrientToDirection,
  Particle,
  ParticleSystem,
  ParticleForceField,
  Renderer,
  RotationOverLifetime,
  RotationByDepth,
  RotationBySize,
  RotationBySpeed,
  ScaleByDepth,
  ScaleBySpeed,
  ScaleOverLifetime,
  SpeedByDepth,
  SpeedBySize,
  SpeedOverLifetime,
  SpriteRenderer,
  TrailRenderer,
  TransformByNoise,
  VelocityByDepth,
  VelocityBySize,
  VelocityOverLifetime,
  MaxCulling,
} from '@rzmps/rzmps';
import { Curve, NumberKeyframe } from 'curves';
import createDopplerBullet from '../presets/particles/dopplerBullet';
import createFireworks from '../presets/particles/fireworks';
import createSnow from '../presets/particles/snow';

class NoopRenderer extends Renderer {
  setup() {}
  _update() {}
  updateGPU() {}
  destroy() {}
  clear() {}
}

function pairBenchmarkCases(cases) {
  return cases.flatMap((benchmarkCase) => {
    const modes = benchmarkCase.gpuOnly
      ? ['gpu']
      : benchmarkCase.cpuOnly
        ? ['cpu']
        : ['cpu', 'gpu'];

    return modes.map((mode) => {
      const gpuProcessing = mode === 'gpu';
      return {
        ...benchmarkCase,
        name: `${benchmarkCase.name} [${mode.toUpperCase()}]`,
        benchmarkMode: mode,
        requireGPU: gpuProcessing,
        create: benchmarkCase.create
          ? () => ({ ...benchmarkCase.create(mode), gpuProcessing })
          : undefined,
        createSystem: benchmarkCase.createSystem
          ? async () => {
            const system = await benchmarkCase.createSystem(mode);
            configureHierarchyGPU(system, gpuProcessing);
            return system;
          }
          : undefined,
        configure: benchmarkCase.configure
          ? (system) => benchmarkCase.configure(system, mode)
          : undefined,
        validate: benchmarkCase.validate
          ? (system) => benchmarkCase.validate(system, mode)
          : undefined,
      };
    });
  });
}

async function createBenchmarkRenderer(defaultProps) {
  const renderer = new WebGPURenderer(defaultProps);

  RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());

  renderer.library.addLight(AmbientLightNode, THREE.AmbientLight);
  renderer.library.addLight(DirectionalLightNode, THREE.DirectionalLight);
  renderer.library.addLight(HemisphereLightNode, THREE.HemisphereLight);
  renderer.library.addLight(PointLightNode, THREE.PointLight);
  renderer.library.addLight(RectAreaLightNode, THREE.RectAreaLight);
  renderer.library.addLight(SpotLightNode, THREE.SpotLight);

  await renderer.init();

  return renderer;
}

function makeCurve() {
  return new Curve([
    new NumberKeyframe(0, 0),
    new NumberKeyframe(0.35, 1),
    new NumberKeyframe(1, 0.25),
  ]);
}

const growCurve = makeCurve();
const fadeCurve = makeCurve();
const DEFAULT_DURATION_MS = 4000;
const DEFAULT_WARMUP_MS = 1000;

function createParticleTexture() {
  const canvas = document.createElement('canvas');
  const size = 64;
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );

  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(0.35, 'rgba(255, 210, 120, 0.85)');
  gradient.addColorStop(1, 'rgba(255, 130, 40, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function getNumberParam(name, fallback) {
  const value = Number(new URLSearchParams(window.location.search).get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getStringParam(name, fallback = '') {
  return new URLSearchParams(window.location.search).get(name) ?? fallback;
}

function createParticle(index) {
  const particle = new Particle({
    lifetime: 10000,
    position: new THREE.Vector3(
      (index % 200) * 0.035 - 3.5,
      (Math.floor(index / 200) % 200) * 0.035 - 3.5,
      0,
    ),
    rotation: new THREE.Vector3(),
    scale: new THREE.Vector3(0.08, 0.08, 0.08),
    velocity: new THREE.Vector3(0.01, 0.02, 0),
    angularVelocity: new THREE.Vector3(0, 0, 0.05),
    color: new THREE.Color(1, 1, 1),
    alpha: 1,
    mass: 1,
    tags: index % 2 === 0 ? ['even'] : ['odd'],
  });

  return particle;
}

function createSystem({
  particleCount,
  initialParticleCount = particleCount,
  maxParticles = Math.max(particleCount, 1),
  emitters = [],
  modules = [],
  spatialEffects = [],
  renderer = new NoopRenderer(),
  gpuProcessing = false,
  maxCullingMode = MaxCulling.New,
}) {
  const system = new ParticleSystem({
    emitters,
    renderers: renderer,
    modules,
    spatialEffects,
    gravityModifier: 0,
    gpuProcessing,
    looping: false,
    maxParticles,
    maxCullingMode,
    useUpdateLOD: false,
  });

  for (let i = 0; i < initialParticleCount; i += 1) {
    system.particles.push(createParticle(i));
  }

  return system;
}

function createMilestoneGPUModules(count) {
  return Array.from({ length: count }, (_unused, index) => (
    new VelocityOverLifetime({
      acceleration: new THREE.Vector3(
        0.0005 * (index + 1),
        -0.00025 * (index + 1),
        0.000125 * (index + 1),
      ),
    })
  ));
}

function createNativeBuiltInModules() {
  return [
    new ColorByDepth(),
    new ColorBySize(),
    new ColorBySpeed(),
    new ColorOverLifetime(),
    new Collision({ gpuCollision: true }),
    new DistortionByDepth(),
    new DistortionBySize(),
    new DistortionBySpeed(),
    new DistortionOverLifetime(),
    new ForceOverLifetime(),
    new LimitVelocityOverLifetime(),
    new MassByDepth(),
    new MassBySize(),
    new MassOverLifetime(),
    new OrientToDirection(),
    new RotationByDepth(),
    new RotationBySize(),
    new RotationBySpeed(),
    new RotationOverLifetime(),
    new ScaleByDepth({}),
    new ScaleBySpeed(),
    new ScaleOverLifetime(),
    new SpeedByDepth(),
    new SpeedBySize(),
    new SpeedOverLifetime(),
    new TransformByNoise({ strength: new THREE.Vector3(0.01, 0.01, 0.01), scrollSpeed: 1 }),
    new VelocityByDepth(),
    new VelocityBySize(),
    new VelocityOverLifetime(),
  ];
}

function configureHierarchyGPU(system, enabled) {
  system.gpuProcessing = enabled;
  system.subSystems.forEach((_options, child) => configureHierarchyGPU(child, enabled));
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

function slowestFrameAverage(values, fraction) {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => b - a);
  const count = Math.max(1, Math.ceil(values.length * fraction));
  const slowest = sorted.slice(0, count);
  return slowest.reduce((sum, value) => sum + value, 0) / slowest.length;
}

function summarize({
  name,
  particleCount,
  system,
  updateSamples,
  frameSamples,
  particleSamples,
  measuredDurationMs,
  maxHeapMB,
  requireGPU,
  gpuActiveSamples,
  computeDispatchSamples,
  simulationDispatchSamples,
  renderOutputDispatchSamples,
  rendererType,
  simulationNodeBuilds,
  benchmarkMode,
}) {
  const updateTotal = updateSamples.reduce((sum, value) => sum + value, 0);
  const frameTotal = frameSamples.reduce((sum, value) => sum + value, 0);
  const slowestOnePercentFrameMs = slowestFrameAverage(frameSamples, 0.01);
  const p99FrameMs = percentile(frameSamples, 0.99);
  const p95UpdateMs = percentile(updateSamples, 0.95);
  const computeTotal = computeDispatchSamples.reduce((sum, value) => sum + value, 0);
  const simulationDispatchTotal = simulationDispatchSamples.reduce((sum, value) => sum + value, 0);
  const renderOutputDispatchTotal = renderOutputDispatchSamples.reduce((sum, value) => sum + value, 0);
  const gpuBufferStats = system.gpuBufferStats;
  const estimatedPersistentGPUBufferMB = (gpuBufferStats.allocated * 12 * 4 * 4) / (1024 * 1024);

  return {
    name,
    benchmarkMode,
    particles: particleCount,
    minSimulatedParticles: Math.min(...particleSamples),
    maxSimulatedParticles: Math.max(...particleSamples),
    finalSimulatedParticles: system.particles.length,
    maxParticlesLimit: system.maxParticles,
    updateLODEnabled: system.useUpdateLOD
      || system.modules.some((module) => module.useUpdateLOD)
      || system.renderers.some((renderer) => renderer.useUpdateLOD),
    countLODEnabled: system.renderers.some((renderer) => Boolean(renderer.countLOD)),
    frames: frameSamples.length,
    avgFps: frameSamples.length / (measuredDurationMs / 1000),
    onePercentLowFps: 1000 / slowestOnePercentFrameMs,
    avgFrameMs: frameTotal / frameSamples.length,
    slowestOnePercentFrameMs,
    p99FrameMs,
    maxFrameMs: Math.max(...frameSamples),
    avgUpdateMs: updateTotal / updateSamples.length,
    p95UpdateMs,
    maxHeapMB,
    gpuProcessingRequested: Boolean(requireGPU),
    gpuActiveFrames: gpuActiveSamples.filter(Boolean).length,
    gpuMeasuredFrames: gpuActiveSamples.length,
    gpuProcessingActive: gpuActiveSamples.length > 0 && gpuActiveSamples.every(Boolean),
    avgComputeDispatches: computeDispatchSamples.length > 0
      ? computeTotal / computeDispatchSamples.length
      : 0,
    maxComputeDispatches: computeDispatchSamples.length > 0
      ? Math.max(...computeDispatchSamples)
      : 0,
    avgSimulationDispatches: simulationDispatchSamples.length > 0
      ? simulationDispatchTotal / simulationDispatchSamples.length
      : 0,
    avgRenderOutputDispatches: renderOutputDispatchSamples.length > 0
      ? renderOutputDispatchTotal / renderOutputDispatchSamples.length
      : 0,
    estimatedPersistentGPUBufferMB,
    rendererType,
    deathEvents: system.__rzmpsBenchmarkDeathEvents,
    gpuEventStats: system.gpuEventStats,
    gpuSelectiveReadbackStats: system.gpuSelectiveReadbackStats,
    simulationNodeBuilds,
    gpuConfigurationStats: system.gpuConfigurationStats,
  };
}

function BenchmarkScene({ onComplete, onProgress }) {
  const { scene, gl, camera } = useThree();
  const active = useRef(null);
  const starting = useRef(false);
  const caseIndex = useRef(-1);
  const results = useRef([]);
  const lastFrame = useRef();
  const durationMs = getNumberParam('durationMs', DEFAULT_DURATION_MS);
  const warmupMs = getNumberParam('warmupMs', DEFAULT_WARMUP_MS);
  const suite = getStringParam('suite');

  if (
    suite === 'milestone1'
    || suite === 'milestone2'
    || suite === 'milestone3'
    || suite === 'milestone4'
    || suite === 'doppler'
    || suite === 'runtime-config'
  ) {
    ParticleSystem.GPU_READBACK_RATE = 0;
  }

  if (gl.compute && !gl.__rzmpsBenchmarkComputeWrapped) {
    const originalCompute = gl.compute.bind(gl);
    gl.__rzmpsBenchmarkComputeDispatches = 0;
    gl.compute = (...args) => {
      gl.__rzmpsBenchmarkComputeDispatches += 1;
      return originalCompute(...args);
    };
    gl.__rzmpsBenchmarkComputeWrapped = true;
  }

  const cases = useMemo(() => {
    if (suite === 'milestone1') {
      const particleCounts = [1_000, 10_000, 100_000];
      const moduleCounts = [1, 5, 10, 20];

      return pairBenchmarkCases([...particleCounts.flatMap((particleCount) => (
        moduleCounts.map((moduleCount) => ({
          name: `Milestone 1 ${particleCount.toLocaleString()} particles ${moduleCount} modules`,
          particleCount,
          requireGPU: true,
          create: () => ({
            gpuProcessing: true,
            maxParticles: particleCount,
            renderer: new NoopRenderer(),
            modules: createMilestoneGPUModules(moduleCount),
          }),
        }))
      )), {
        name: 'Milestone 1 all built-in modules',
        particleCount: 1_000,
        requireGPU: true,
        create: () => ({
          gpuProcessing: true,
          maxParticles: 1_000,
          renderer: new NoopRenderer(),
          modules: createNativeBuiltInModules(),
        }),
      }]);
    }

    if (suite === 'milestone2') {
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
          modules: [
            ...createMilestoneGPUModules(1),
            new OrientToDirection(),
          ],
        }),
        configure: (system) => {
          system.particles.forEach((particle) => {
            particle.lifetime = 0.01;
          });
          system.__rzmpsBenchmarkDeathEvents = 0;
          system.onDeath(() => {
            system.__rzmpsBenchmarkDeathEvents += 1;
          });
        },
        validate: (system) => {
          const overflowCount = system.gpuEventStats.overflowCount;
          const minimumOverflow = particleCount - ParticleSystem.GPU_EVENT_BUFFER_CAPACITY;
          if (expectOverflow && overflowCount < minimumOverflow) {
            throw new Error(
              `Milestone 2 reported ${overflowCount} overflows; expected at least ${minimumOverflow}.`,
            );
          }
        },
      });
      return pairBenchmarkCases([
        deathEventCase(4096, 4096),
        {
          ...deathEventCase(5000, ParticleSystem.GPU_EVENT_BUFFER_CAPACITY, true),
          gpuOnly: true,
        },
      ]);
    }

    if (suite === 'milestone3') {
      const forceFields = Array.from({ length: 128 }, (_unused, index) => (
        ParticleForceField.Sphere({
          position: new THREE.Vector3(
            (index % 16) * 0.45 - 3.4,
            Math.floor(index / 16) * 0.45 - 1.6,
            0,
          ),
          direction: new THREE.Vector3((index % 3) * 0.01, 0.02, 0),
          gravity: index % 5 === 0 ? 0.03 : 0,
          multiplier: 0.5 + (index % 7) * 0.1,
        }, 0.65, 8, 4)
      ));
      return pairBenchmarkCases([{
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
            system.addSpatialEffect(ParticleForceField.Sphere({
              position: new THREE.Vector3(0, 0, 0),
              direction: new THREE.Vector3(0, 0.02, 0),
              multiplier: 0.75,
            }, 0.65, 8, 4));
            system.__rzmpsAddedSpatialInstance = true;
          }
          if (system._gpuSpatialRegistry && system.__rzmpsSpatialVersion === undefined) {
            system.__rzmpsSpatialVersion = system._gpuSpatialRegistry.version;
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
          if (system._gpuSpatialRegistry?.version !== system.__rzmpsSpatialVersion) {
            throw new Error('Milestone 3 replaced GPU resources while adding an existing effect type.');
          }
          if (system.__rzmpsSimulationNodeBuilds !== 1) {
            throw new Error(`Milestone 3 rebuilt its simulation shader ${system.__rzmpsSimulationNodeBuilds} times.`);
          }
        },
      }]);
    }

    if (suite === 'milestone4') {
      return pairBenchmarkCases([{
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
          emitters: [new Emitter({
            source: EmissionShape.Sphere(0.05),
            rate: 100,
            tags: ['gpu-parent'],
            initialValues: {
              lifetime: 0.35,
              position: new THREE.Vector3(0.05, 0.1, -0.05),
              velocity: new THREE.Vector3(0, 1, 0),
            },
          })],
          modules: createMilestoneGPUModules(1),
        }),
        configure: (system) => {
          system.__rzmpsBenchmarkSpawnEvents = 0;
          system.__rzmpsBenchmarkDeathEvents = 0;
          system.onSpawn(() => { system.__rzmpsBenchmarkSpawnEvents += 1; });
          system.onDeath(() => { system.__rzmpsBenchmarkDeathEvents += 1; });
          const smoke = new ParticleSystem({
            gpuProcessing: true,
            maxParticles: 256,
            emitters: [new Emitter({
              source: EmissionShape.Sphere(0.02),
              rate: 18,
              rateOverDistance: 2,
              initialValues: { lifetime: 0.5 },
            })],
            modules: createMilestoneGPUModules(1),
            renderers: [new NoopRenderer()],
          });
          const bursts = new ParticleSystem({
            gpuProcessing: true,
            looping: false,
            duration: 0.5,
            maxParticles: 256,
            emitters: [new Emitter({
              source: EmissionShape.Cone(0.05, 0.1),
              rate: 4,
              bursts: [
                { time: 0, count: 4 },
                { time: 0.5, count: 2 },
              ],
              initialValues: { lifetime: 0.3 },
            })],
            modules: createMilestoneGPUModules(1),
            renderers: [new NoopRenderer()],
          });
          const nestedSparks = new ParticleSystem({
            gpuProcessing: true,
            looping: false,
            duration: 0.25,
            maxParticles: 128,
            emitters: [new Emitter({
              source: EmissionShape.Sphere(0.01),
              rate: 0,
              bursts: [{ time: 0, count: 2 }],
              initialValues: { lifetime: 0.15 },
            })],
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
        validate: (system) => {
          const children = system.__rzmpsBenchmarkChildren ?? [];
          if (system.particles.length !== 0 || children.some((child) => child.particles.length !== 0)) {
            throw new Error('Milestone 4 created CPU Particle objects for GPU-native emission.');
          }
          if (!system._gpuBuffers || children.some((child) => !child._gpuBuffers)) {
            throw new Error('Milestone 4 did not initialize every GPU-native particle pool.');
          }
          if (
            !children[0]._gpuContinuousEmitterInstances
            || !children[0]._gpuEventEmitterInstances
            || !children[1]._gpuEmissionRuns
            || !children[2]._gpuEmissionRuns
          ) {
            throw new Error('Milestone 4 did not initialize mixed contexts and nested persistent event runs.');
          }
          if (system.__rzmpsBenchmarkSpawnEvents <= 0 || system.__rzmpsBenchmarkDeathEvents <= 0) {
            throw new Error('Milestone 4 did not deliver asynchronous GPU spawn/death callbacks.');
          }
        },
      }, {
        name: 'Milestone 4 actual fireworks',
        particleCount: 0,
        minimumDurationMs: 3500,
        createSystem: () => createFireworks(),
        configure: (system) => {
          system.__rzmpsBenchmarkSpawnEvents = 0;
          system.__rzmpsBenchmarkDeathEvents = 0;
          system.onSpawn(() => { system.__rzmpsBenchmarkSpawnEvents += 1; });
          system.onDeath(() => { system.__rzmpsBenchmarkDeathEvents += 1; });
        },
        validate: (system, mode) => {
          if (mode === 'cpu') {
            if (system.isGPUProcessingActive || system.particles.length <= 0) {
              throw new Error('Actual fireworks CPU mode did not remain on CPU or emit rockets.');
            }
            return;
          }
          const children = [...system.subSystems.keys()];
          const smoke = children.find((child) => child.name === 'Rocket Smoke');
          const sparkles = children.find((child) => child.name === 'Sparkles');
          if (!smoke?._gpuContinuousEmitterInstances || !sparkles?._gpuEmissionRuns) {
            throw new Error('Actual fireworks did not use GPU smoke contexts and sparkle runs.');
          }
          if (system.particles.length || smoke.particles.length || sparkles.particles.length) {
            throw new Error('Actual fireworks created CPU particles in GPU mode.');
          }
          if (system.__rzmpsBenchmarkSpawnEvents <= 0 || system.__rzmpsBenchmarkDeathEvents <= 0) {
            throw new Error('Actual fireworks did not deliver launch and explosion event callbacks.');
          }
        },
      }]);
    }

    if (suite === 'doppler') {
      return pairBenchmarkCases([{
        name: 'Doppler Bullet offset emission',
        particleCount: 0,
        minimumDurationMs: 3000,
        createSystem: () => createDopplerBullet(),
        configure: (system) => {
          system.__rzmpsBenchmarkSpawnPositions = [];
          system.onSpawn((particle) => {
            system.__rzmpsBenchmarkSpawnPositions.push(particle.position.clone());
          });
        },
        validate: (system, mode) => {
          const spawn = system.__rzmpsBenchmarkSpawnPositions[0];
          if (!spawn || spawn.z < 25) {
            throw new Error(
              `Doppler Bullet [${mode.toUpperCase()}] spawned at ${spawn?.toArray().join(', ') ?? 'no position'}; expected the offset cone near z=34.`,
            );
          }
        },
      }]);
    }

    if (suite === 'runtime-config') {
      return [{
        name: 'Runtime GPU parameter synchronization',
        benchmarkMode: 'gpu',
        particleCount: 0,
        requireGPU: true,
        create: () => ({
          gpuProcessing: true,
          initialParticleCount: 0,
          maxParticles: 512,
          renderer: new NoopRenderer(),
          emitters: [new Emitter({
            rate: 40,
            rateOverDistance: 1,
            bursts: [{ time: 0.1, count: 2 }],
            initialValues: { lifetime: 2 },
          })],
        }),
        beforeUpdate: (system) => {
          const emitter = system.emitters[0];
          if (!system.__rzmpsRuntimeBaseline && system._gpuEmissionPrepareComputeCache) {
            system.__rzmpsRuntimeBaseline = {
              ...system.gpuConfigurationStats,
              node: system._gpuEmissionPrepareComputeCache.nodes[0],
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
            if (system._gpuEmissionPrepareComputeCache.nodes[0] !== baseline.node) {
              throw new Error('Numeric emitter parameters replaced the emission graph.');
            }
            system.__rzmpsRuntimeNumericVerified = true;
            emitter.rate = (time) => 20 + time * 20;
            return;
          }

          if (system.__rzmpsRuntimeNumericVerified && !system.__rzmpsRuntimeStructuralVerified) {
            const baseline = system.__rzmpsRuntimeBaseline;
            if (system.gpuConfigurationStats.pipelineBuilds <= baseline.pipelineBuilds) return;
            if (system._gpuEmissionPrepareComputeCache.nodes[0] === baseline.node) {
              throw new Error('Structural emitter change retained the stale emission graph.');
            }
            system.__rzmpsRuntimeStructuralVerified = true;
          }
        },
        validate: (system) => {
          if (!system.__rzmpsRuntimeNumericVerified || !system.__rzmpsRuntimeStructuralVerified) {
            throw new Error('Runtime configuration synchronization did not complete.');
          }
        },
      }, {
        name: 'Snow CPU/GPU reset isolation',
        benchmarkMode: 'mixed',
        particleCount: 0,
        requireGPU: false,
        minimumDurationMs: 2500,
        createSystem: async () => {
          const system = await createSnow();
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
            system.__rzmpsSnowSwitchedToCPU
            && !system.isGPUProcessingActive
            && !system.__rzmpsSnowSwitchedBack
            && elapsed > 700
          ) {
            system.gpuProcessing = true;
            system.__rzmpsSnowSwitchedBack = true;
          }
        },
        validate: (system) => {
          const renderer = system.renderers[0];
          const expectedBuffer = system._gpuRenderOutputBuffers ?? system._gpuBuffers;
          if (!system.__rzmpsSnowSwitchedBack || !system.isGPUProcessingActive) {
            throw new Error('Snow did not return to GPU processing after reset.');
          }
          if (!expectedBuffer || renderer.webgpuGPUMaterialBuffer !== expectedBuffer) {
            throw new Error('Snow renderer retained a stale pre-reset GPU buffer.');
          }
        },
      }];
    }

    return pairBenchmarkCases([{
      name: 'Baseline 10k simulation only',
      particleCount: 10_000,
      create: () => ({ modules: [] }),
    },
    {
      name: 'Baseline 50k simulation only',
      particleCount: 50_000,
      create: () => ({ modules: [] }),
    },
    {
      name: 'Fused modules 10k simulation only',
      particleCount: 10_000,
      requireGPU: true,
      create: () => ({
        gpuProcessing: true,
        renderer: new NoopRenderer(),
        modules: [
          new ForceOverLifetime({ force: new THREE.Vector3(0.1, -0.15, 0.05) }),
          new VelocityOverLifetime({ linear: new THREE.Vector3(0.01, 0.02, 0) }),
        ],
      }),
    },
    {
      name: 'Heavy modules 10k',
      particleCount: 10_000,
      requireGPU: true,
      create: () => ({
        gpuProcessing: true,
        renderer: new NoopRenderer(),
        modules: [
          new ForceOverLifetime({ force: new THREE.Vector3(0.1, -0.15, 0.05) }),
          new VelocityOverLifetime({ linear: new THREE.Vector3(0.01, 0.02, 0) }),
          new ColorOverLifetime({
            color: (time) => new THREE.Color(1, 0.6 + 0.4 * fadeCurve.evaluate(time), 0.25),
            alpha: (time) => fadeCurve.evaluate(time),
          }),
          new ScaleOverLifetime({
            scale: (time) => new THREE.Vector3(1, 1, 1).multiplyScalar(0.5 + growCurve.evaluate(time)),
          }),
          new RotationOverLifetime({ angularVelocity: new THREE.Vector3(0, 0, 1) }),
        ],
      }),
    },
    {
      name: 'Spatial kill zones 10k',
      particleCount: 10_000,
      requireGPU: true,
      create: () => ({
        gpuProcessing: true,
        renderer: new NoopRenderer(),
        modules: [
          new VelocityOverLifetime({ linear: new THREE.Vector3(0.01, 0.02, 0) }),
        ],
        spatialEffects: [
          KillZone.Sphere({ position: new THREE.Vector3(0, 0, 0), feather: 0.4 }, 1.5, 16, 8),
          KillZone.Torus({ position: new THREE.Vector3(1.5, 0, 0), feather: 0.25 }, 1, 0.25, 16, 8),
        ],
      }),
    },
    {
      name: 'Typical VFX 5k sprite',
      particleCount: 5_000,
      create: () => ({
        renderer: new SpriteRenderer(createParticleTexture()),
        modules: [
          new VelocityOverLifetime({ linear: new THREE.Vector3(0.01, 0.02, 0) }),
          new ForceOverLifetime({ force: new THREE.Vector3(0, -0.01, 0) }),
          new ColorOverLifetime({
            color: (time) => new THREE.Color(1, 0.6 + 0.4 * fadeCurve.evaluate(time), 0.25),
            alpha: (time) => fadeCurve.evaluate(time),
          }),
          new ScaleOverLifetime({
            scale: (time) => new THREE.Vector3(1, 1, 1).multiplyScalar(0.5 + growCurve.evaluate(time)),
          }),
          new RotationOverLifetime({ angularVelocity: new THREE.Vector3(0, 0, 1) }),
        ],
      }),
    },
    {
      name: 'Heavy modules 10k noise+forces',
      particleCount: 10_000,
      create: () => ({
        modules: [
          new ForceOverLifetime({ force: new THREE.Vector3(0.1, -0.15, 0.05) }),
          new NoiseModule('bench-noise'),
        ],
      }),
    },
    {
      name: 'Spawn churn 2k/sec simulation only',
      particleCount: 10_000,
      create: () => ({
        initialParticleCount: 0,
        maxParticles: 10_000,
        emitters: new Emitter({
          rate: 2_000,
          radialSpeed: 1.5,
          alignment: 1,
          initialValues: {
            lifetime: 5,
            scale: new THREE.Vector3(0.05, 0.05, 0.05),
            velocity: new THREE.Vector3(0.02, 0.04, 0),
            color: new THREE.Color(1, 0.65, 0.25),
          },
        }),
      }),
    },
    {
      name: 'Renderer tag filtering 10k x4 noop',
      particleCount: 10_000,
      create: () => ({
        renderer: [
          new NoopRenderer({ tags: 'even' }),
          new NoopRenderer({ tags: 'odd' }),
          new NoopRenderer({ tags: 'even' }),
          new NoopRenderer({ tags: 'odd' }),
        ],
      }),
    },
    {
      name: 'Renderer count LOD compensate 10k noop',
      particleCount: 10_000,
      create: () => ({
        renderer: new NoopRenderer({
          countLOD: {
            distance: 1,
            quality: 0.5,
            maxLevel: 1,
          },
          compensateSize: true,
        }),
      }),
    },
    {
      name: 'SpriteRenderer 5k rendered',
      particleCount: 5_000,
      create: () => ({ renderer: new SpriteRenderer(createParticleTexture()) }),
    },
    {
      name: 'SpriteRenderer 10k rendered',
      particleCount: 10_000,
      create: () => ({ renderer: new SpriteRenderer(createParticleTexture()) }),
    },
    {
      name: 'SpriteRenderer 50k rendered',
      particleCount: 50_000,
      create: () => ({ renderer: new SpriteRenderer(createParticleTexture()) }),
    },
    {
      name: 'MeshRenderer 10k rendered',
      particleCount: 10_000,
      create: () => ({ renderer: new MeshRenderer({ maxParticles: 10_000 }) }),
    },
    {
      name: 'TrailRenderer 2k rendered',
      particleCount: 2_000,
      create: () => ({ renderer: new TrailRenderer({ texture: createParticleTexture() }) }),
    },
    ]);
  }, [suite]);

  const startNextCase = async () => {
    if (starting.current) return;
    starting.current = true;
    if (active.current?.system) {
      active.current.system.destroy();
      active.current = null;
    }

    caseIndex.current += 1;

    const nextCase = cases[caseIndex.current];
    if (!nextCase) {
      window.__RZMPS_BENCHMARK_RESULTS__ = results.current;
      window.__RZMPS_BENCHMARK_DONE__ = true;
      onComplete(results.current);
      starting.current = false;
      return;
    }

    const system = nextCase.createSystem
      ? await nextCase.createSystem()
      : createSystem({
        particleCount: nextCase.particleCount,
        ...nextCase.create(),
      });
    nextCase.configure?.(system);
    system._renderer = gl;
    system._scene = scene;
    system._camera = camera;
    system.__rzmpsBenchmarkComputeDispatches = 0;
    system.__rzmpsBenchmarkSimulationDispatches = 0;
    system.__rzmpsBenchmarkRenderOutputDispatches = 0;
    system.__rzmpsSimulationNodeBuilds = 0;

    const originalSimulationPhase = system._computeGPUSimulationPhase.bind(system);
    system._computeGPUSimulationPhase = (...args) => {
      system.__rzmpsBenchmarkComputeDispatches += 1;
      system.__rzmpsBenchmarkSimulationDispatches += 1;
      return originalSimulationPhase(...args);
    };

    const originalRenderOutputPhase = system._computeGPURenderOutputPhase.bind(system);
    system._computeGPURenderOutputPhase = (...args) => {
      system.__rzmpsBenchmarkComputeDispatches += 1;
      system.__rzmpsBenchmarkRenderOutputDispatches += 1;
      return originalRenderOutputPhase(...args);
    };

    scene.add(system);
    active.current = {
      ...nextCase,
      system,
      phase: 'warmup',
      phaseStartedAt: performance.now(),
      updateSamples: [],
      frameSamples: [],
      particleSamples: [],
      gpuActiveSamples: [],
      computeDispatchSamples: [],
      simulationDispatchSamples: [],
      renderOutputDispatchSamples: [],
      simulationNodes: new WeakSet(),
      simulationNodeBuilds: 0,
      maxHeapMB: 0,
      rendererType: gl.isWebGPURenderer ? 'WebGPURenderer' : gl.constructor.name,
    };
    lastFrame.current = undefined;
    onProgress(nextCase.name);
    starting.current = false;
  };

  useFrame(() => {
    if (!active.current) {
      void startNextCase().catch((error) => {
        setTimeout(() => { throw error; });
      });
      return;
    }

    const frameStart = performance.now();
    const updateStart = performance.now();
    const computeDispatchesBefore = active.current.system.__rzmpsBenchmarkComputeDispatches
      ?? gl.__rzmpsBenchmarkComputeDispatches
      ?? 0;
    const simulationDispatchesBefore = active.current.system.__rzmpsBenchmarkSimulationDispatches ?? 0;
    const renderOutputDispatchesBefore = active.current.system.__rzmpsBenchmarkRenderOutputDispatches ?? 0;
    active.current.beforeUpdate?.(active.current.system, frameStart - active.current.phaseStartedAt);
    active.current.system.update();
    const simulationNode = active.current.system._gpuSimulationComputeCache?.node;
    if (simulationNode && !active.current.simulationNodes.has(simulationNode)) {
      active.current.simulationNodes.add(simulationNode);
      active.current.simulationNodeBuilds += 1;
      active.current.system.__rzmpsSimulationNodeBuilds = active.current.simulationNodeBuilds;
    }
    const computeDispatchesAfter = active.current.system.__rzmpsBenchmarkComputeDispatches
      ?? gl.__rzmpsBenchmarkComputeDispatches
      ?? computeDispatchesBefore;
    const simulationDispatchesAfter = active.current.system.__rzmpsBenchmarkSimulationDispatches
      ?? simulationDispatchesBefore;
    const renderOutputDispatchesAfter = active.current.system.__rzmpsBenchmarkRenderOutputDispatches
      ?? renderOutputDispatchesBefore;
    const updateMs = performance.now() - updateStart;
    let elapsed = frameStart - active.current.phaseStartedAt;

    if (active.current.phase === 'warmup') {
      if (elapsed >= warmupMs) {
        active.current.phase = 'measure';
        active.current.phaseStartedAt = frameStart;
        lastFrame.current = frameStart;
      }
      return;
    }

    const caseDurationMs = Math.max(durationMs, active.current.minimumDurationMs ?? 0);
    const awaitingExpectedEvents = active.current.expectedDeathEvents
      && (active.current.system.__rzmpsBenchmarkDeathEvents ?? 0) < active.current.expectedDeathEvents;
    if (active.current.phase === 'drain') {
      if (awaitingExpectedEvents && elapsed < 5000) {
        lastFrame.current = frameStart;
        return;
      }
      elapsed = caseDurationMs;
    }

    if (lastFrame.current !== undefined) {
      active.current.frameSamples.push(frameStart - lastFrame.current);
    }

    lastFrame.current = frameStart;
    active.current.updateSamples.push(updateMs);
    active.current.computeDispatchSamples.push(computeDispatchesAfter - computeDispatchesBefore);
    active.current.simulationDispatchSamples.push(simulationDispatchesAfter - simulationDispatchesBefore);
    active.current.renderOutputDispatchSamples.push(renderOutputDispatchesAfter - renderOutputDispatchesBefore);
    active.current.particleSamples.push(active.current.system.liveParticleCount ?? active.current.system.particles.length);
    active.current.gpuActiveSamples.push(active.current.system.isGPUProcessingActive);

    if (active.current.requireGPU && !active.current.system.isGPUProcessingActive) {
      throw new Error(`${active.current.name} did not activate GPU processing.`);
    }

    const heapBytes = performance.memory?.usedJSHeapSize;
    if (Number.isFinite(heapBytes)) {
      active.current.maxHeapMB = Math.max(active.current.maxHeapMB, heapBytes / (1024 * 1024));
    }

    if (elapsed >= caseDurationMs) {
      if (
        active.current.phase === 'measure'
        && awaitingExpectedEvents
      ) {
        active.current.phase = 'drain';
        active.current.phaseStartedAt = frameStart;
        return;
      }
      if (
        active.current.expectedDeathEvents
        && (active.current.system.__rzmpsBenchmarkDeathEvents ?? 0) < active.current.expectedDeathEvents
      ) {
        throw new Error(
          `${active.current.name} dispatched ${active.current.system.__rzmpsBenchmarkDeathEvents ?? 0}`
          + ` GPU death events; expected ${active.current.expectedDeathEvents}.`,
        );
      }
      active.current.validate?.(active.current.system);
      active.current.measuredDurationMs = elapsed;
      results.current.push(summarize(active.current));
      gl.info.reset();
      void startNextCase().catch((error) => {
        setTimeout(() => { throw error; });
      });
    }
  });

  return null;
}

function BenchmarkPage() {
  const [results, setResults] = useState([]);
  const [activeCase, setActiveCase] = useState('Starting');
  const status = results.length > 0
    ? `${results.length} cases completed`
    : 'warming up';

  return (
    <div className="demo-shell">
      <Canvas
        camera={{ position: [0, 0, 8], near: 0.1, far: 100 }}
        gl={createBenchmarkRenderer}
        onCreated={({ gl }) => gl.setClearColor('#202020')}
      >
        <ambientLight intensity={1} />
        <BenchmarkScene onComplete={setResults} onProgress={setActiveCase} />
      </Canvas>

      <div className="benchmark-status">
        <strong>Benchmark</strong>
        <span>{activeCase}</span>
        <small>{status}</small>
      </div>

      <pre className="code-panel">
        <code>
          {JSON.stringify({ activeCase, results }, null, 2)}
        </code>
      </pre>
    </div>
  );
}

export default BenchmarkPage;
