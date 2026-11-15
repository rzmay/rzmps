import * as THREE from 'three';
import { Easing } from 'eaz';
import { float, mix, smoothstep } from 'three/tsl';
import warpNormal from 'examples/assets/images/warp_norm.jpg?url';
import checkerboardScene from 'examples/scenes/checkerboard.js';
import {
  Emitter,
  EmissionShape,
  ColorOverLifetime,
  Collision,
  ForceOverLifetime,
  GasSimulation,
  GasModule,
  ParticleSystem,
  ScaleOverLifetime,
  TransformByNoise,
  VolumeRenderer,
  LightRenderer,
  Textures,
  SpriteRenderer,
  RotationOverLifetime,
  VelocityOverLifetime,
} from '@rzmps/rzmps';

export default async function createVolumetricFire() {
  // #region docs:modules:1
  const gas = new GasSimulation({
    supportSpatialEffects: true,
    collisionOptions: { surfaceThickness: 0.02, bakedFieldResolution: 32 },
    pressureIterations: 16,
    externalForce: new THREE.Vector3(0, 0.05, 0),
    densityDissipation: 0.2,
    temperatureDissipation: 4,
    colorDissipation: 0.9,
    velocityDissipation: 0.15,
    buoyancy: 8,
    weight: 0.03,
    sourceStrength: 8,
    velocitySourceStrength: 2.2,
    sourceTemperature: 1.2,
    temperatureOverLifetime: (time) => 1 - time,
    // Preserve thin structures: strong diffusion rounds the plume into soft smoke lobes.
    scalarDiffusion: 0.02,
    vorticityStrength: 10,
    turbulenceNoiseStrength: 1,
    // Slightly shorter-lived hot gas; retain the exported cool-smoke decay and flow settings.
    temperatureRange: [0, 1.2],
    densityDissipationByTemperature: [1.2, 1.5],
    // Start compact; physical bounds and the cell-width cap remain independent.
    automaticPadding: true,
    turbulenceNoiseFrequency: 2.4,
    turbulenceNoiseSpeed: 0.95,
    turbulenceNoiseOctaves: 2,
    spatialGridOptions: {
      maxBounds: 16,
      brickSubdivisions: 3,
      cellSubdivisions: 3,
      // Start at the authored world-space resolution instead of oversampling a tiny initial domain.
      minVolumeQuality: 8,
      // 8 / 2^(3 + 3) = 0.125: larger domains must not make the fire coarser.
      maxVolumeQuality: 8,
      powerOfTwoBounds: true,
      autoExpand: false,
      shrinkDelay: 180,
    },
  });
  // #endregion docs:modules:1

  // #region docs:system:1
  const system = new ParticleSystem({
    duration: 10,
    looping: true,
    // #region docs:emitters:1
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.22, 18, 10),
        rate: 50,
        radialSpeed: 1,
        initialValues: {
          lifetime: 1.2,
          mass: 1,
          speed: 0.8,
          scale: 0.25,
          color: new THREE.Color('white'),
          alpha: 0.9,
          velocity: new THREE.Vector3(0, 2.4, 0),
        },
      }),
    ],
    // #endregion docs:emitters:1
    // #region docs:modules:2
    modules: [
      gas,
      // Keep the configured mask authoritative: preserve dense cores and sharpen sparse hot tongues.
      new GasModule({
        modifyRenderGPU(cell, context) {
          const hot = smoothstep(0.15, 0.8, cell.temperature);
          const dense = smoothstep(0.2, 1.2, cell.density);
          const hotContrast = mix(float(1.6), float(0.75), dense);
          context.densityNoiseContrast.mulAssign(mix(float(1), hotContrast, hot));
        },
      }),
      new Collision({ lifetimeLoss: 1 }),
      new ForceOverLifetime({
        force: new THREE.Vector3(0, 0.35, 0),
      }),
      new TransformByNoise({
        strength: new THREE.Vector3(0.35, 0.12, 0.35),
        frequency: 1.8,
      }),
      new ScaleOverLifetime({
        scale: (time) => {
          const size = 1 - 0.8 * time;
          return new THREE.Vector3(size, size, size);
        },
      }),
      new ColorOverLifetime({
        color: new THREE.Color('white'),
        alpha: (time) => 1 - THREE.MathUtils.smoothstep(time, 0.65, 1),
      }),
    ],
    // #endregion docs:modules:2
    // #region docs:renderers:1
    renderers: [
      new VolumeRenderer({
        lightingGridOptions: { cellSize: 0.25, directions: 12, samplesPerInterval: 8, maxDistance: 16 },
        // Heat-distortion sprites draw at order one and must sample the already rendered volume.
        renderOrder: 0,
        opacity: 0.75,
        threshold: 0.025,
        range: 0.02,
        steps: 256,
        samplesPerVoxel: 2,
        color: 0xffffff,
        temperatureRange: [0, 1],
        colorByTemperature: (heat) => {
          const smoke = new THREE.Color('#62656b');
          const flame = new THREE.Color('#ff5108');
          const core = new THREE.Color('#fff4b0');
          return heat < 0.35 ? smoke.lerp(flame, THREE.MathUtils.smoothstep(heat, 0.08, 0.35))
            : flame.lerp(core, THREE.MathUtils.smoothstep(heat, 0.35, 1));
        },
        opacityByTemperature: [0.25, 2],
        // Hot gas has distinct flame tongues; smoke uses a gentler, slightly finer mask.
        densityNoiseStrengthByTemperature: [0.25, 1.5],
        densityNoiseContrastByTemperature: [0.5, 1.25],
        densityNoiseFrequencyByTemperature: [1.25, 1],
        densityNoiseStrength: 1,
        densityNoiseContrast: 2,
        densityNoiseFrequency: 1,
        densityNoiseSpeed: 2,
        densityNoiseOctaves: 1,
      }),
      new LightRenderer({
        count: 2,
        ratio: 0.01,
        brightness: 4,
        rangeMultiplier: 4,
        alphaAffectsIntensity: true,
        inheritParticleColor: false,
        lightOptions: { color: '#ff842b', distance: 8 },
      }),
    ],
    // #endregion docs:renderers:1
  });
  // #endregion docs:system:1

  // #region docs:subsystems:1
  // Keep the transmitting heat-distortion subsystem configuration beside its parent preset.
  const distortionMap = new THREE.TextureLoader().load(warpNormal);
  const distortion = new ParticleSystem({
    duration: 1,
    looping: true,
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.05, 8, 6),
        rate: 4,
        radialSpeed: 1,
        initialValues: {
          lifetime: 0.9,
          scale: 1.5,
          velocity: new THREE.Vector3(0, 0.6, 0),
          color: '#ffffff',
          rotation: [-Math.PI, Math.PI],
        },
      }),
    ],
    modules: [
      new VelocityOverLifetime({
        linear: new THREE.Vector3(0, 0.5, 0),
      }),
      new TransformByNoise({
        strength: new THREE.Vector3(0.65, 0.35, 0.65),
        frequency: 1.7,
      }),
      new ScaleOverLifetime({
        scale: (time) => {
          const size = (0.35 + (1.8 - 0.35) * time) * (1 - Easing.cubic.in(THREE.MathUtils.clamp(time, 0, 1)));
          return size;
        },
      }),
      new ColorOverLifetime({
        alpha: (time) => Easing.cubic.in(THREE.MathUtils.clamp(time * 5, 0,
          1)) * (1 - Easing.cubic.in(THREE.MathUtils.clamp((time - 0.8) * 5, 0, 1))),
      }),
      new RotationOverLifetime({
        angularVelocity: [-0.45, 0.45],
      }),
    ],
    renderers: [
      new SpriteRenderer(Textures.Default, {
        alphaMap: Textures.Simple,
        softParticleDistance: 0,
        materialOptions: {
          transmission: 1,
          distortionMap,
          distortionStrength: 0.05,
          depthWrite: false,
        },
      }),
    ],
  });
  system.addSubSystem(distortion, {
    ratio: 0.2,
    inheritScale: 0,
    inheritLifetime: 0,
    inheritColor: 0,
    inheritAlpha: 0,
    inheritMass: 0,
  });
  system.addEventListener('destroyed', () => distortionMap.dispose());
  // #endregion docs:subsystems:1

  system.name = 'Volumetric Fire';
  system.position.set(0, 0, 0);

  return system;
}

/** @type {import('../types').ExampleMetadata} */
createVolumetricFire.metadata = {
  author: 'rzmay',
  id: 'volumetricFire',
  title: 'Volumetric Fire',
  description: 'Flickering volumetric flames, cooling smoke, particle lights and secondary heat distortion.',
  tags: ['gas', 'fire', 'volume', 'lights', 'distortion', 'webgpu'],
  previewSettings: {
    backend: 'webgpu', duration: 10, scene: checkerboardScene,
    cameraPosition: [3, 2, 4.5], cameraTarget: [0, 0.8, 0], cameraFov: 45
  },
};
