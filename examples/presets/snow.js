import { Curve } from 'curves';
import { SpriteMaterialType } from '@rzmps/rzmps';
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
import snowflakeAlpha from 'examples/assets/images/snowflake_alpha.png?url';

export default async function snowPreset() {
  // #region docs:system:1

  // #region docs:emitters:1
  const snowEmitters = [
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
  ];
  // #endregion docs:emitters:1

  // #region docs:modules:1
  const snowModules = [
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
      angularVelocity: 0.65,
    }),

    new ColorOverLifetime({
      alpha: new Curve({ 0: 0, 0.2: 1, 1: 0 }),
    }),

    new ColorByDepth({
      alpha: [1, 0.5],
      depthRange: [6, 24],
    }),

    new ColorByDepth({
      alpha: [0, 1],
      depthRange: [1, 2],
    }),
  ];
  // #endregion docs:modules:1

  // #region docs:renderers:1
  const snowRenderers = [
    new SpriteRenderer(Textures.Default, {
      material: SpriteMaterialType.Lit,
      children: { count: 5, radius: 1.5, scale: [0.9, 0.5], alpha: [0.9, 0.6] },
      alphaMap: snowflakeAlpha,
      materialOptions: {
        normalLighting: 0.25,
        sphericalNormals: 0.1,
      },
    }),
  ];
  // #endregion docs:renderers:1

  // #region docs:system:assembly
  const snow = new ParticleSystem({
    duration: 10,
    prewarm: true,
    looping: true,
    gravityModifier: 0.025,

    emitters: snowEmitters,

    modules: snowModules,

    renderers: snowRenderers,
  });
  // #endregion docs:system:assembly
  // #endregion docs:system:1

  snow.name = 'Snow';
  snow.position.set(0, 5, 0);

  return snow;
}

/** @type {import("../types").ExampleMetadata} */
snowPreset.metadata = {
  author: 'rzmay',
  id: 'snow',
  title: 'Snow',
  description: 'Depth-based fading, noise-driven motion, warmup, and broad low-cost emission.',
  tags: ['snow', 'children', 'renderer-children', 'weather', 'sprites', 'noise', 'depth', 'effects'],
  previewSettings: {
    duration: 10,
  },
};
