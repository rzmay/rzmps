import measurementSettings from '../../../benchmarks/config/measurement.json';
import { benchmarkCaseId } from '../../../benchmarks/lib/benchmark-selection.mjs';
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
  ForceOverLifetime,
  LimitVelocityOverLifetime,
  MassByDepth,
  MassBySize,
  MassOverLifetime,
  OrientToDirection,
  Particle,
  ParticleSystem,
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
  TransformByNoise,
  VelocityByDepth,
  VelocityBySize,
  VelocityOverLifetime,
  MaxCulling,
} from '@rzmps/rzmps';
import { Curve, NumberKeyframe } from 'curves';

class NoopRenderer extends Renderer {
  setup() {}
  _update() {}
  _updateGPU() {}
  destroy() {}
  clear() {}
}

function pairBenchmarkCases(cases) {
  return cases.flatMap(benchmarkCase => {
    const modes = benchmarkCase.gpuOnly ? ['gpu'] : benchmarkCase.cpuOnly ? ['cpu'] : ['cpu', 'gpu'];

    return modes.map(mode => {
      const gpuProcessing = mode === 'gpu';
      return {
        ...benchmarkCase,
        id: benchmarkCase.id
          ? `${benchmarkCase.id}:${mode}`
          : benchmarkCaseId({ name: `${benchmarkCase.name} [${mode.toUpperCase()}]` }),
        name: `${benchmarkCase.name} [${mode.toUpperCase()}]`,
        benchmarkMode: mode,
        requireGPU: gpuProcessing,
        create: benchmarkCase.create ? () => ({ ...benchmarkCase.create(mode), gpuProcessing }) : undefined,
        createSystem: benchmarkCase.createSystem
          ? async () => {
              const system = await benchmarkCase.createSystem(mode);
              configureHierarchyGPU(system, gpuProcessing);
              return system;
            }
          : undefined,
        configure: benchmarkCase.configure ? system => benchmarkCase.configure(system, mode) : undefined,
        validate: benchmarkCase.validate ? system => benchmarkCase.validate(system, mode) : undefined,
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

  if (renderer.backend.isWebGPUBackend !== true) {
    throw new Error('GPU benchmarks require a native WebGPU backend; Three.js selected its WebGL fallback.');
  }

  return renderer;
}

function makeCurve() {
  return new Curve([new NumberKeyframe(0, 0), new NumberKeyframe(0.35, 1), new NumberKeyframe(1, 0.25)]);
}

const growCurve = makeCurve();

const fadeCurve = makeCurve();

const DEFAULT_DURATION_MS = measurementSettings.profiles.default.durationMs;

const DEFAULT_WARMUP_MS = measurementSettings.profiles.default.warmupMs;

function createParticleTexture() {
  const canvas = document.createElement('canvas');
  const size = 64;
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);

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
    position: new THREE.Vector3((index % 200) * 0.035 - 3.5, (Math.floor(index / 200) % 200) * 0.035 - 3.5, 0),
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
  lod,
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
    lod,
  });

  for (let i = 0; i < initialParticleCount; i += 1) {
    system.particles.push(createParticle(i));
  }

  return system;
}

function createMilestoneGPUModules(count) {
  return Array.from(
    { length: count },
    (_unused, index) =>
      new VelocityOverLifetime({
        acceleration: new THREE.Vector3(0.0005 * (index + 1), -0.00025 * (index + 1), 0.000125 * (index + 1)),
      }),
  );
}

function createNativeBuiltInModules() {
  return [
    new ColorByDepth(),
    new ColorBySize(),
    new ColorBySpeed(),
    new ColorOverLifetime(),
    new Collision(),
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

function summarize({
  id,
  path,
  feature,
  backend,
  name,
  particleCount,
  system,
  benchmarks,
  measuredDurationMs,
  maxHeapMB,
  requireGPU,
  rendererType,
  simulationNodeBuilds,
  benchmarkMode,
  report: fluidReport,
  reportKey = 'gas',
}) {
  const report = benchmarks.report();
  const metric = name => report.metrics[`benchmark/${name}`];
  const update = metric('update'),
    frame = metric('frame'),
    particles = metric('particleCount');
  const compute = metric('computeDispatches'),
    simulation = metric('simulationDispatches');
  const renderOutput = metric('renderOutputDispatches'),
    gpuActive = metric('gpuActive');
  const slowestOnePercentFrameMs = frame.slowestOnePercentMean;
  const estimatedPersistentGPUBufferMB = (benchmarks.snapshot()['gpu/allocatedBytes'] ?? 0) / (1024 * 1024);

  return {
    id,
    path,
    feature,
    backend,
    name,
    benchmarkMode,
    particles: particleCount,
    minSimulatedParticles: particles.min,
    maxSimulatedParticles: particles.max,
    finalSimulatedParticles: system.particles.length,
    maxParticlesLimit: system.maxParticles,
    lodEnabled: Boolean(system.lod),
    quality: system.quality,
    frames: frame.count,
    avgFps: frame.count / (measuredDurationMs / 1000),
    onePercentLowFps: 1000 / slowestOnePercentFrameMs,
    avgFrameMs: frame.mean,
    slowestOnePercentFrameMs,
    p99FrameMs: frame.p99,
    maxFrameMs: frame.max,
    avgUpdateMs: update.mean,
    p95UpdateMs: update.p95,
    maxHeapMB,
    gpuProcessingRequested: Boolean(requireGPU),
    gpuActiveFrames: gpuActive.sum,
    gpuMeasuredFrames: gpuActive.count,
    gpuProcessingActive: gpuActive.count > 0 && gpuActive.min === 1,
    avgComputeDispatches: compute.mean ?? 0,
    maxComputeDispatches: compute.max ?? 0,
    avgSimulationDispatches: simulation.mean ?? 0,
    avgRenderOutputDispatches: renderOutput.mean ?? 0,
    estimatedPersistentGPUBufferMB,
    measurements: report,
    rendererType,
    deathEvents: system.__rzmpsBenchmarkDeathEvents,
    gpuEventStats: system.gpuEventStats,
    gpuSelectiveReadbackStats: system.gpuSelectiveReadbackStats,
    simulationNodeBuilds,
    gpuConfigurationStats: system.gpuConfigurationStats,
    spatialGridDiagnostics: system.__gridDiagnostics,
    dynamicSpatialDiagnostics: system.__dynamicSpatialDiagnostics,
    emitterInstanceDiagnostics: system.__emitterInstanceDiagnostics,
    ...(fluidReport ? { [reportKey]: fluidReport() } : {}),
  };
}

export {
  NoopRenderer,
  pairBenchmarkCases,
  createBenchmarkRenderer,
  makeCurve,
  growCurve,
  fadeCurve,
  DEFAULT_DURATION_MS,
  DEFAULT_WARMUP_MS,
  createParticleTexture,
  getNumberParam,
  getStringParam,
  createParticle,
  createSystem,
  createMilestoneGPUModules,
  createNativeBuiltInModules,
  configureHierarchyGPU,
  summarize,
};
