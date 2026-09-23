/* eslint-disable react/no-unknown-property */
import React, { useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  ColorOverLifetime,
  ForceOverLifetime,
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
    color: new THREE.Color(1, 1, 1),
    alpha: 1,
    mass: 1,
    tags: index % 2 === 0 ? ['even'] : ['odd'],
  });

  particle.velocity.set(0.01, 0.02, 0);
  particle.angularVelocity.set(0, 0, 0.05);
  particle.cacheStartValues();

  return particle;
}

function createSystem({ particleCount, modules = [], renderer = new NoopRenderer() }) {
  const system = new ParticleSystem({
    emitters: [],
    renderers: renderer,
    modules,
    gravityModifier: 0,
    looping: false,
    maxParticles: Math.max(particleCount, 1),
  });

  for (let i = 0; i < particleCount; i += 1) {
    system.particles.push(createParticle(i));
  }

  return system;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

function summarize({ name, particleCount, updateSamples, frameSamples, maxHeapMB }) {
  const updateTotal = updateSamples.reduce((sum, value) => sum + value, 0);
  const frameTotal = frameSamples.reduce((sum, value) => sum + value, 0);
  const fpsSamples = frameSamples.map((value) => 1000 / value);

  return {
    name,
    particles: particleCount,
    frames: frameSamples.length,
    avgFps: 1000 / (frameTotal / frameSamples.length),
    minFps: Math.min(...fpsSamples),
    maxFps: Math.max(...fpsSamples),
    avgFrameMs: frameTotal / frameSamples.length,
    maxFrameMs: Math.max(...frameSamples),
    avgUpdateMs: updateTotal / updateSamples.length,
    p95UpdateMs: percentile(updateSamples, 0.95),
    maxHeapMB,
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
      maxHeapMB: 0,
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

    const heapBytes = performance.memory?.usedJSHeapSize;
    if (Number.isFinite(heapBytes)) {
      active.current.maxHeapMB = Math.max(active.current.maxHeapMB, heapBytes / (1024 * 1024));
    }

    if (elapsed >= durationMs) {
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
      <Canvas camera={{ position: [0, 0, 8], near: 0.1, far: 100 }} onCreated={({ gl }) => gl.setClearColor('#202020')}>
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
