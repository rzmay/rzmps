import * as THREE from 'three';
import {
  ColorOverLifetime,
  Emitter,
  EmissionShape,
  NoiseModule,
  ParticleSystem,
  ScaleOverLifetime,
  SpriteRenderer,
  Textures,
  TransformByNoise,
  VelocityOverLifetime,
} from '@rzmps/rzmps';
import { curvePresets } from '../curvePresets';

const moduleUpdateLOD = {
  distance: 10,
  quality: 0.5,
  falloff: 1,
  maxLevel: 1,
  continuous: true,
};

const countLOD = {
  distance: 10,
  quality: 0.7,
  falloff: 1,
  maxLevel: 5,
  continuous: true,
};

export default async function createLODStress() {
  const system = new ParticleSystem({
    duration: 10,
    looping: true,
    maxParticles: 50000,
    simulationSpeed: 1,
    gravity: new THREE.Vector3(0, 0, 0),
    gravityModifier: 0,

    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.7, 24, 12),
        rate: 1800,
        radialSpeed: 1.8,
        countLOD,
        initialValues: {
          lifetime: [2.5, 5],
          speed: [0.6, 1.8],
          scale: new THREE.Vector3(0.08, 0.08, 0.08),
          color: new Set([
            new THREE.Color('#57d6ff'),
            new THREE.Color('#fff176'),
            new THREE.Color('#ff6fb1'),
            new THREE.Color('#8aff8a'),
          ]),
          alpha: 0.85,
        },
      }),
    ],

    modules: [
      new VelocityOverLifetime({
        linear: new THREE.Vector3(0, 0.35, 0),
        useUpdateLOD: true,
        updateLOD: moduleUpdateLOD,
      }),
      new TransformByNoise({
        strength: new THREE.Vector3(2.5, 2.5, 2.5),
        frequency: 2.2,
        useUpdateLOD: true,
        updateLOD: moduleUpdateLOD,
      }),
      new NoiseModule('lodStress', {
        frequency: 1.5,
        octaves: 3,
        useUpdateLOD: true,
        updateLOD: moduleUpdateLOD,
      }),
      new ScaleOverLifetime({
        scale: (time) => {
          const size = curvePresets.fadeInOut.evaluate(time);
          return new THREE.Vector3(size, size, size);
        },
      }),
      new ColorOverLifetime({
        alpha: (time) => curvePresets.fadeOut.evaluate(time),
      }),
    ],

    renderers: [
      new SpriteRenderer(Textures.Circle, {
        material: 'basic',
        softParticleDistance: 1,
        countLOD,
        compensateSize: true,
      }),
    ],
  });

  system.name = 'LOD Stress Test';
  system.position.set(0, 0, 0);

  return system;
}

createLODStress.author = "rzmay";
