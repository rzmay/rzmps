import * as THREE from 'three';
import {
  Emitter,
  EmissionShape,
  LimitVelocityOverLifetime,
  ParticleSystem,
  RotationOverLifetime,
  SpriteRenderer,
  TransformByNoise,
  ColorOverLifetime,
  ColorByDepth,
  Textures,
} from '@rzmps/rzmps';
import snowflakeAlpha from '../apps/demo/src/assets/images/snowflake_alpha.png?url';

export default async function createSnow() {
  // #region docs:system:1
  const snow = new ParticleSystem({
    duration: 10,
    prewarm: true,
    looping: true,
    gravityModifier: 0.025,
    // #region docs:emitters:1
    emitters: [
      new Emitter({
        source: new EmissionShape({
          geometry: new THREE.BoxGeometry(30, 0.1, 30),
        }),
        rate: 70,
        radialSpeed: 0,
        initialValues: {
          lifetime: 16,
          speed: 1,
          scale: 0.25,
          color: '#e9f7ff',
          alpha: 0.9,
          velocity: new THREE.Vector3(0, -0.35, 0),
        },
      }),
    ],
    // #endregion docs:emitters:1
    // #region docs:modules:1
    modules: [
      new TransformByNoise({
        strength: new THREE.Vector3(0.28, 0.02, 0.28),
        frequency: 0.55,
      }),
      new LimitVelocityOverLifetime({
        limit: new THREE.Vector3(0.7, 0.65, 0.7),
        drag: 0.12,
        multiplyDragByVelocity: true,
      }),
      new RotationOverLifetime({
        angularVelocity: new THREE.Vector3(0.65, 0, 0),
      }),
      new ColorOverLifetime({
        alpha: (t) => ((t) < 0.2 ? (t) / 0.2 : (t) < 0.75 ? 1 - 0.15 * (((t) - 0.2) / 0.55) : 0.85 * (1 - (((t) - 0.75) / 0.25)))
      }),
      new ColorByDepth({
        alpha: [1, 0.5],
        depthRange: [6, 24],
      }),
      new ColorByDepth({
        alpha: [0, 1],
        depthRange: [1, 2],
      }),
    ],
    // #endregion docs:modules:1
    // #region docs:renderers:1
    renderers: [
      new SpriteRenderer(Textures.Default, {
        material: 'lit',
        children: { count: 2, radius: 1.5, scale: [0.9, 0.5], alpha: [0.9, 0.6] },
        alphaMap: snowflakeAlpha,
        materialOptions: {
          normalLighting: 0.25,
          sphericalNormals: 0.1
        }
      }),
    ],
    // #endregion docs:renderers:1
  });
  // #endregion docs:system:1

  snow.name = 'Snow';
  snow.position.set(0, 5, 0);

  return snow;
}

createSnow.author = "rzmay";

/** @type {import("./types").ExampleMetadata} */
export const metadata = {
  "id": "snow",
  "title": "Snow",
  "description": "Depth-based fading, noise-driven motion, warmup, and broad low-cost emission.",
  "tags": [
    "snow"
  ],
  "category": "effects"
};

createSnow.description = metadata.description;
