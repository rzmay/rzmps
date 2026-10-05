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
  Emitter,
  ForceOverLifetime,
  KillZone,
  MeshRenderer,
  NoiseModule,
  Particle,
  ParticleSystem,
  Renderer,
  RotationOverLifetime,
  ScaleOverLifetime,
  SpriteRenderer,
  TrailRenderer,
  VelocityOverLifetime,
} from '@rzmps/rzmps';
import { Curve, NumberKeyframe } from 'curves';

class NoopRenderer extends Renderer {
  setup() {}
  _update() {}
  destroy() {}
  clear() {}
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
    useUpdateLOD: false,
  });

  for (let i = 0; i < initialParticleCount; i += 1) {
    system.particles.push(createParticle(i));
  }

  return system;
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
  rendererType,
}) {
  const updateTotal = updateSamples.reduce((sum, value) => sum + value, 0);
  const frameTotal = frameSamples.reduce((sum, value) => sum + value, 0);
  const slowestOnePercentFrameMs = slowestFrameAverage(frameSamples, 0.01);
  const p99FrameMs = percentile(frameSamples, 0.99);
  const p95UpdateMs = percentile(updateSamples, 0.95);

  return {
    name,
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
    rendererType,
  };
}

function BenchmarkScene({ onComplete, onProgress }) {
  const { scene, gl } = useThree();
  const active = useRef(null);
  const caseIndex = useRef(-1);
  const results = useRef([]);
  const lastFrame = useRef();
  const durationMs = getNumberParam('durationMs', DEFAULT_DURATION_MS);
  const warmupMs = getNumberParam('warmupMs', DEFAULT_WARMUP_MS);

  const cases = useMemo(() => [
    {
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
      name: 'GPU forced baseline 10k simulation only',
      particleCount: 10_000,
      requireGPU: true,
      create: () => ({
        gpuProcessing: true,
        modules: [
          new ForceOverLifetime({ force: new THREE.Vector3(0.1, -0.15, 0.05) }),
          new VelocityOverLifetime({ linear: new THREE.Vector3(0.01, 0.02, 0) }),
        ],
      }),
    },
    {
      name: 'GPU forced heavy modules 10k',
      particleCount: 10_000,
      requireGPU: true,
      create: () => ({
        gpuProcessing: true,
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
      name: 'GPU forced spatial kill zones 10k',
      particleCount: 10_000,
      requireGPU: true,
      create: () => ({
        gpuProcessing: true,
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
  ], []);

  const startNextCase = () => {
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
      return;
    }

    const system = createSystem({
      particleCount: nextCase.particleCount,
      ...nextCase.create(),
    });

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
      maxHeapMB: 0,
      rendererType: gl.isWebGPURenderer ? 'WebGPURenderer' : gl.constructor.name,
    };
    lastFrame.current = undefined;
    onProgress(nextCase.name);
  };

  useFrame(() => {
    if (!active.current) {
      startNextCase();
      return;
    }

    const frameStart = performance.now();
    const updateStart = performance.now();
    active.current.system.update();
    const updateMs = performance.now() - updateStart;
    const elapsed = frameStart - active.current.phaseStartedAt;

    if (active.current.phase === 'warmup') {
      if (elapsed >= warmupMs) {
        active.current.phase = 'measure';
        active.current.phaseStartedAt = frameStart;
        lastFrame.current = frameStart;
      }
      return;
    }

    if (lastFrame.current !== undefined) {
      active.current.frameSamples.push(frameStart - lastFrame.current);
    }

    lastFrame.current = frameStart;
    active.current.updateSamples.push(updateMs);
    active.current.particleSamples.push(active.current.system.liveParticleCount ?? active.current.system.particles.length);
    active.current.gpuActiveSamples.push(active.current.system.isGPUProcessingActive);

    if (active.current.requireGPU && !active.current.system.isGPUProcessingActive) {
      throw new Error(`${active.current.name} did not activate GPU processing.`);
    }

    const heapBytes = performance.memory?.usedJSHeapSize;
    if (Number.isFinite(heapBytes)) {
      active.current.maxHeapMB = Math.max(active.current.maxHeapMB, heapBytes / (1024 * 1024));
    }

    if (elapsed >= durationMs) {
      active.current.measuredDurationMs = elapsed;
      results.current.push(summarize(active.current));
      gl.info.reset();
      startNextCase();
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
