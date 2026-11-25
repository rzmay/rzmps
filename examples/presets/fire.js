import { Curve } from 'curves';
import checkerboardScene from 'examples/scenes/checkerboard.js';
import * as THREE from 'three';
import {
  ColorOverLifetime,
  DecalRenderer,
  Emitter,
  EmissionShape,
  EmissionSource,
  ForceOverLifetime,
  LightRenderer,
  ParticleSystem,
  RotationOverLifetime,
  ScaleOverLifetime,
  SpriteRenderer,
  TransformByNoise,
  VelocityOverLifetime,
  Textures,
} from '@rzmps/rzmps';
import fireSprite from 'examples/assets/images/fire_tile_8x4_n32.png?url';
import warpNormal from 'examples/assets/images/warp_norm.jpg?url';
import scorchTexture from 'examples/assets/images/scorch.png?url';
import { Easing } from 'eaz';

export default async function firePreset() {
  // #region docs:system:resources
  const textureLoader = new THREE.TextureLoader();
  const heatDistortion = textureLoader.load(warpNormal);
  const scorchMap = textureLoader.load(scorchTexture);
  scorchMap.colorSpace = THREE.SRGBColorSpace;
  const scorchMaterial = new THREE.MeshBasicMaterial({ map: scorchMap });

  // #endregion docs:system:resources

  // #region docs:system:1

  // #region docs:emitters:1
  const fireEmitters = [
    new Emitter({
      source: new EmissionShape({
        geometry: new THREE.ConeGeometry(1, 1.7, 24),
        source: EmissionSource.Surface,
      }),
      rate: 90,
      radialSpeed: 0.2,
      initialValues: {
        lifetime: 1.35,
        speed: 1.2,
        scale: 2.5,
        color: ['#ff9c88', '#ffd47f'],
        alpha: 0.95,
        velocity: new THREE.Vector3(0, 2.2, 0),
      },
    }),
  ];
  // #endregion docs:emitters:1

  // #region docs:modules:1
  const fireModules = [
    new VelocityOverLifetime({
      linear: new THREE.Vector3(0, 0.25, 0),
    }),

    new TransformByNoise({
      strength: 2.1,
      frequency: 1.35,
    }),

    new ForceOverLifetime({
      force: new THREE.Vector3(0, 0.5, 0),
    }),

    new ScaleOverLifetime({
      scale: time => THREE.MathUtils.lerp(1.3, 0.2, Easing.linear.in(time)),
    }),

    new ColorOverLifetime({
      color: '#ffffff',
      alpha: new Curve({ 0: 0, 0.2: 1, 1: 0 }),
    }),

    new RotationOverLifetime({
      angularVelocity: [new THREE.Vector3(-0.5, 0, 0), new THREE.Vector3(0.5, 0, 0)],
    }),
  ];
  // #endregion docs:modules:1

  // #region docs:renderers:1
  const fireRenderers = [
    new SpriteRenderer(fireSprite, {
      gridSize: { x: 8, y: 4 },
      frames: 32,
      fps: 24,
      softParticleDistance: 1,
    }),

    new LightRenderer({
      count: 18,
      ratio: 0.3,
      inheritParticleColor: true,
      sizeAffectsRange: true,
      alphaAffectsIntensity: true,
      brightness: 1.8,
      rangeMultiplier: 3,
      lightOptions: {
        color: '#ffb570',
        intensity: 1,
        distance: 8,
        decay: 2,
      },
    }),

    new DecalRenderer(scorchMaterial, {
      onSpawn: false,
      ratio: 0.5,
      continuousRate: 3,
      direction: DecalRenderer.Radial(24),
      hitSelection: (hits, particle, maxHits) =>
        DecalRenderer.Random(DecalRenderer.Nearest(hits, particle, 5), particle, maxHits),
      maxDistance: 1.5,
      depth: 0.06,
      size: 2.5,
      inheritColor: 0,
      inheritScale: 0,
      inheritAlpha: 0,
      lifetime: 8,
      opacity: new Curve({ 0: 0, 0.025: 0.05, 0.6: 0.05, 1: 0 }),
      maxDecals: 100,
    }),
  ];
  // #endregion docs:renderers:1

  // #region docs:system:assembly
  const fire = new ParticleSystem({
    duration: 10,
    looping: true,

    emitters: fireEmitters,

    modules: fireModules,

    renderers: fireRenderers,
  });
  // #endregion docs:system:assembly
  // #endregion docs:system:1

  // #region docs:system:connections
  fire.addSubSystem(
    createHeatDistortion(Textures.Simple, heatDistortion, {
      rate: 4,
      scale: 4,
      velocity: 0,
      lifetime: 1,
    }),
    {
      inheritScale: 0,
      inheritLifetime: 0,
      inheritColor: 0,
      inheritAlpha: 0,
      inheritMass: 0,
      ratio: 0.5,
    },
  );
  // #endregion docs:system:connections

  fire.addEventListener('destroyed', () => {
    scorchMaterial.dispose();
    scorchMap.dispose();
  });
  fire.name = 'Fire';
  fire.position.set(0, 0, 0);

  return fire;
}

// #region docs:system:2
function createHeatDistortion(alphaMap, distortionMap, options) {
  // #region docs:emitters:2
  const heatDistortionEmitters = [
    new Emitter({
      source: EmissionShape.Sphere(0.05, 8, 6),
      rate: options.rate,
      radialSpeed: 1,
      initialValues: {
        lifetime: options.lifetime,
        scale: options.scale,
        velocity: new THREE.Vector3(0, options.velocity, 0),
        color: '#ffffff',
        rotation: [-Math.PI, Math.PI],
      },
    }),
  ];
  // #endregion docs:emitters:2

  // #region docs:modules:2
  const heatDistortionModules = [
    new VelocityOverLifetime({
      linear: new THREE.Vector3(0, 0.5, 0),
    }),

    new TransformByNoise({
      strength: new THREE.Vector3(0.65, 0.35, 0.65),
      frequency: 1.7,
    }),

    new ScaleOverLifetime({
      scale: time => {
        const size = (0.35 + (1.8 - 0.35) * time) * (1 - Easing.cubic.in(THREE.MathUtils.clamp(time, 0, 1)));
        return size;
      },
    }),

    new ColorOverLifetime({
      alpha: time =>
        Easing.cubic.in(THREE.MathUtils.clamp(time * 5, 0, 1)) *
        (1 - Easing.cubic.in(THREE.MathUtils.clamp((time - 0.8) * 5, 0, 1))),
    }),

    new RotationOverLifetime({
      angularVelocity: [-0.45, 0.45],
    }),
  ];
  // #endregion docs:modules:2

  // #region docs:renderers:2
  const heatDistortionRenderers = [
    new SpriteRenderer(Textures.Default, {
      alphaMap,
      softParticleDistance: 2.5,
      materialOptions: {
        transmission: 1,
        distortionMap,
        distortionStrength: 0.05,
        depthWrite: false,
      },
    }),
  ];
  // #endregion docs:renderers:2

  return new ParticleSystem({
    duration: 1,
    looping: true,

    emitters: heatDistortionEmitters,

    modules: heatDistortionModules,

    renderers: heatDistortionRenderers,
  });
}
// #endregion docs:system:2

/** @type {import("../types").ExampleMetadata} */
firePreset.metadata = {
  author: 'rzmay',
  id: 'fire',
  title: 'Fire',
  description:
    'Sprite-sheet flames, particle lights, heat distortion, and persistent textured scorch marks on nearby surfaces.',
  tags: [
    'fire',
    'flames',
    'sprites',
    'sprite-sheet',
    'lights',
    'distortion',
    'decals',
    'scorch',
    'soot',
    'ash',
    'effects',
  ],
  previewSettings: {
    duration: 10,
    scene: checkerboardScene,
  },
};
