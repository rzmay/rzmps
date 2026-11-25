import { Curve } from 'curves';
import checkerboardScene from 'examples/scenes/checkerboard.js';
import * as THREE from 'three';
import {
  ColorOverLifetime,
  DecalRenderer,
  Emitter,
  EmissionShape,
  ForceOverLifetime,
  LightRenderer,
  ParticleSystem,
  RotationOverLifetime,
  ScaleOverLifetime,
  SpriteRenderer,
  Textures,
  TransformByNoise,
  VelocityOverLifetime,
} from '@rzmps/rzmps';
import fireballSprite from 'examples/assets/images/fireball_tile_5x4_n20.png?url';
import warpNormal from 'examples/assets/images/warp_norm.jpg?url';
import scorchTexture from 'examples/assets/images/scorch.png?url';
import { Easing } from 'eaz';

export default async function fireballPreset() {
  // #region docs:system:resources
  const textureLoader = new THREE.TextureLoader();
  const heatDistortion = textureLoader.load(warpNormal);
  const scorchMap = textureLoader.load(scorchTexture);
  scorchMap.colorSpace = THREE.SRGBColorSpace;
  const scorchMaterial = new THREE.MeshBasicMaterial({ map: scorchMap });

  // #endregion docs:system:resources

  // #region docs:system:1
  // #region docs:emitters:1
  const fireballEmitters = [
    new Emitter({
      source: new EmissionShape({
        geometry: new THREE.SphereGeometry(0.2, 16, 12),
      }),
      rate: 0,
      bursts: [{ time: 0, count: 5 }],
      initialValues: {
        lifetime: 0.6,
        speed: 1,
        scale: 2.5,
        color: ['#ffffff', '#ffd166'],
        rotation: [-90, 90],
        alpha: 1,
        velocity: new THREE.Vector3(0, 0, 0),
        radial: 0.45,
      },
    }),
  ];
  // #endregion docs:emitters:1

  // #region docs:modules:1
  const fireballModules = [
    new ScaleOverLifetime({
      scale: time => THREE.MathUtils.lerp(0.35, 1.8, Easing.linear.in(time)),
    }),

    new ColorOverLifetime({
      color: '#fff2e8',
      alpha: time => 1 - Easing.cubic.in(THREE.MathUtils.clamp(time, 0, 1)),
    }),
  ];
  // #endregion docs:modules:1

  // #region docs:renderers:1
  const fireballRenderers = [
    new SpriteRenderer(fireballSprite, {
      gridSize: { x: 5, y: 4 },
      frames: 20,
      fps: 30,
      softParticleDistance: 1,
    }),

    new LightRenderer({
      count: 18,
      ratio: 0.3,
      inheritParticleColor: true,
      sizeAffectsRange: true,
      alphaAffectsIntensity: true,
      brightness: 5,
      rangeMultiplier: 3,
      lightOptions: {
        color: '#ffae97',
        intensity: 1,
        distance: 8,
        decay: 2,
      },
    }),

    new DecalRenderer(scorchMaterial, {
      onSpawn: false,
      ratio: 0.5,
      continuousRate: 5,
      direction: DecalRenderer.Radial(24),
      hitSelection: DecalRenderer.Nearest,
      maxHits: 5,
      maxDistance: 2,
      depth: 0.06,
      size: 2.5,
      inheritColor: 0,
      inheritScale: 0,
      inheritAlpha: 0,
      lifetime: 8,
      opacity: new Curve({ 0: 0, 0.025: 0.05, 0.6: 0.05, 1: 0 }),
      maxDecals: 128,
    }),
  ];
  // #endregion docs:renderers:1

  // #region docs:system:assembly
  const fireball = new ParticleSystem({
    duration: 1.25,
    looping: true,

    emitters: fireballEmitters,

    modules: fireballModules,

    renderers: fireballRenderers,
  });
  // #endregion docs:system:assembly
  // #endregion docs:system:1

  // #region docs:system:connections
  fireball.addSubSystem(createHeatDistortion(Textures.Simple, heatDistortion), {
    inheritScale: 0,
    inheritLifetime: 0,
    inheritColor: 0,
    inheritAlpha: 0,
    inheritMass: 0,
    inheritVelocity: 0.5,
    emitOnSpawn: true,
    ratio: 0.55,
  });
  // #endregion docs:system:connections

  fireball.addEventListener('destroyed', () => {
    scorchMaterial.dispose();
    scorchMap.dispose();
  });
  fireball.name = 'Fireball';
  fireball.position.set(0, 0, 0);

  return fireball;
}

// #region docs:system:2
function createHeatDistortion(alphaMap, distortionMap) {
  // #region docs:emitters:2
  const heatDistortionEmitters = [
    new Emitter({
      source: EmissionShape.Sphere(0.05, 8, 6),
      bursts: [{ time: 0, count: 5 }],
      radialSpeed: 2,
      initialValues: {
        lifetime: 0.5,
        scale: 6,
        velocity: new THREE.Vector3(0, 1.35, 0),
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

    new ForceOverLifetime({
      force: new THREE.Vector3(0, 0.5, 0),
    }),

    new TransformByNoise({
      strength: new THREE.Vector3(0.55, 0.3, 0.55),
      frequency: 1.6,
    }),

    new ScaleOverLifetime({
      scale: time => 2 * Easing.cubic.out(time),
    }),

    new ColorOverLifetime({
      alpha: new Curve({ 0: 0, 0.2: 1, 1: 0 }),
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
        opacity: 0.3,
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
fireballPreset.metadata = {
  author: 'rzmay',
  id: 'fireball',
  title: 'Fireball',
  description:
    'Burst emission, animated sprite growth, particle lights, heat distortion, and persistent radial scorch marks.',
  tags: [
    'fireball',
    'explosion',
    'bursts',
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
    // Two burst cycles include the lingering explosion and smoke.
    duration: 2.5,
    scene: checkerboardScene,
  },
};
