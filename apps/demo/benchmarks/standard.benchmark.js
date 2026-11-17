import * as THREE from 'three';
import {
  ColorOverLifetime,
  Emitter,
  EmissionShape,
  EmissionSource,
  ForceOverLifetime,
  KillZone,
  MeshRenderer,
  NoiseModule,
  RotationOverLifetime,
  ScaleOverLifetime,
  SpriteRenderer,
  TrailRenderer,
  VelocityOverLifetime,
} from '@rzmps/rzmps';
import { NoopRenderer, pairBenchmarkCases, growCurve, fadeCurve, createParticleTexture } from './benchmark.utils.js';

export default {
  id: 'standard',
  name: 'standard workloads',
  feature: 'simulation',
  runtime: 'browser',
  backends: ['cpu', 'gpu'],
  createCases({ ciProfile }) {
    return pairBenchmarkCases([
      {
        id: 'baseline-10k',
        name: 'Baseline 10k simulation only',
        particleCount: 10_000,
        create: () => ({ modules: [] }),
      },
      {
        id: 'baseline-50k',
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
        id: 'heavy-modules-10k',
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
              color: time => new THREE.Color(1, 0.6 + 0.4 * fadeCurve.evaluate(time), 0.25),
              alpha: time => fadeCurve.evaluate(time),
            }),
            new ScaleOverLifetime({
              scale: time => new THREE.Vector3(1, 1, 1).multiplyScalar(0.5 + growCurve.evaluate(time)),
            }),
            new RotationOverLifetime({ angularVelocity: new THREE.Vector3(0, 0, 1) }),
          ],
        }),
      },
      {
        id: 'spatial-kill-zones-10k',
        name: 'Spatial kill zones 10k',
        particleCount: 10_000,
        requireGPU: true,
        create: () => ({
          gpuProcessing: true,
          renderer: new NoopRenderer(),
          modules: [new VelocityOverLifetime({ linear: new THREE.Vector3(0.01, 0.02, 0) })],
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
              color: time => new THREE.Color(1, 0.6 + 0.4 * fadeCurve.evaluate(time), 0.25),
              alpha: time => fadeCurve.evaluate(time),
            }),
            new ScaleOverLifetime({
              scale: time => new THREE.Vector3(1, 1, 1).multiplyScalar(0.5 + growCurve.evaluate(time)),
            }),
            new RotationOverLifetime({ angularVelocity: new THREE.Vector3(0, 0, 1) }),
          ],
        }),
      },
      {
        name: 'Heavy modules 10k noise+forces',
        cpuOnly: true,
        particleCount: 10_000,
        create: () => ({
          modules: [
            new ForceOverLifetime({ force: new THREE.Vector3(0.1, -0.15, 0.05) }),
            new NoiseModule('bench-noise'),
          ],
        }),
      },
      {
        id: 'spawn-churn',
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
        name: 'Custom volume spawn churn 2k/sec',
        particleCount: 10_000,
        create: () => ({
          initialParticleCount: 0,
          maxParticles: 10_000,
          emitters: new Emitter({
            source: new EmissionShape({
              geometry: new THREE.TorusGeometry(1, 0.3, 16, 32),
              source: EmissionSource.Volume,
              volumeSamples: 'auto',
            }),
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
        validate: system => {
          const shape = system.emitters[0].source;
          if (shape.resolvedVolumeSamples <= EmissionShape.MIN_AUTO_VOLUME_SAMPLES) {
            throw new Error('Automatic custom-volume sampling did not scale above its minimum.');
          }
        },
      },
      {
        name: 'Surface spawn churn 2k/sec',
        particleCount: 10_000,
        create: () => ({
          initialParticleCount: 0,
          maxParticles: 10_000,
          emitters: new Emitter({
            source: EmissionShape.Torus({ source: EmissionSource.Surface }, 1, 0.3, 16, 32),
            rate: 2_000,
            radialSpeed: 1.5,
            initialValues: {
              lifetime: 5,
              scale: new THREE.Vector3(0.05, 0.05, 0.05),
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
        name: 'Population LOD size compensation 10k noop',
        particleCount: 10_000,
        create: () => ({
          lod: { distance: 1, quality: 0.5, maxLevel: 1 },
          renderer: new NoopRenderer({ compensation: 'size' }),
        }),
      },
      {
        name: 'SpriteRenderer 5k rendered',
        particleCount: 5_000,
        create: () => ({ renderer: new SpriteRenderer(createParticleTexture()) }),
      },
      {
        id: 'sprite-10k',
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
        id: 'mesh-rendered',
        name: ciProfile ? 'MeshRenderer 2k rendered (low-poly)' : 'MeshRenderer 10k rendered',
        particleCount: ciProfile ? 2_000 : 10_000,
        create: () => ({
          renderer: new MeshRenderer({
            maxParticles: ciProfile ? 2_000 : 10_000,
            ...(ciProfile ? { geometry: new THREE.BoxGeometry(1, 1, 1) } : {}),
          }),
        }),
      },
      {
        id: 'trail-2k',
        name: 'TrailRenderer 2k rendered',
        particleCount: 2_000,
        create: () => ({ renderer: new TrailRenderer({ texture: createParticleTexture() }) }),
      },
    ]);
  },
};
