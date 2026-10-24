import * as THREE from 'three';
import {
  ColorOverLifetime,
  CompensationMode,
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
import { Easing } from 'eaz';

const lod = {
  distance: 10,
  quality: 0.7,
  falloff: 1,
  maxLevel: 5,
  continuous: true,
};

export default async function createLODStress() {
  // #region docs:system:1
  const system = new ParticleSystem({
    duration: 10,
    looping: true,
    maxParticles: 50000,
    simulationSpeed: 1,
    lod,
    gravity: new THREE.Vector3(0, 0, 0),
    gravityModifier: 0,

    // #region docs:emitters:1
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.7, 24, 12),
        rate: 1800,
        radialSpeed: 1.8,
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
    // #endregion docs:emitters:1

    // #region docs:modules:1
    modules: [
      new VelocityOverLifetime({
        linear: new THREE.Vector3(0, 0.35, 0),
      }),
      new TransformByNoise({
        strength: new THREE.Vector3(2.5, 2.5, 2.5),
        frequency: 2.2,
      }),
      new ScaleOverLifetime({
        scale: (time) => {
          const size = ((time) < 0.2 ? (time) / 0.2 : (time) < 0.75 ? 1 - 0.15 * (((time) - 0.2) / 0.55) : 0.85 * (1 - (((time) - 0.75) / 0.25)));
          return new THREE.Vector3(size, size, size);
        },
      }),
      new ColorOverLifetime({
        alpha: (time) => (1 - Easing.cubic.in(THREE.MathUtils.clamp(time, 0, 1))),
      }),
    ],
    // #endregion docs:modules:1

    // #region docs:renderers:1
    renderers: [
      new SpriteRenderer(Textures.Circle, {
        material: 'lit',
        softParticleDistance: 1,
        compensation: CompensationMode.Children,
      }),
    ],
    // #endregion docs:renderers:1
  });
  // #endregion docs:system:1

  system.name = 'LOD Stress Test';
  system.position.set(0, 0, 0);

  return system;
}

createLODStress.author = "rzmay";

/** @type {import("./types").ExampleMetadata} */
export const metadata = {
  "id": "lodStress",
  "title": "LOD Stress Test",
  "description": "Unified LOD with density compensation under a dense simulation load.",
  "tags": [
    "lodStress"
  ],
  "category": "effects"
};

createLODStress.description = metadata.description;
