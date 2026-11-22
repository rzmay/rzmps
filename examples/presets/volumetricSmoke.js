import * as THREE from 'three';
import {
  Collision, ColorOverLifetime, Emitter, EmissionShape, ForceOverLifetime, GasSimulation, ParticleSystem,
  ScaleOverLifetime, TransformByNoise, VolumeRenderer
} from '@rzmps/rzmps';

export default async function createVolumetricSmoke() {
  // #region docs:system:1
  const system = new ParticleSystem({
    duration: 10,
    gravityModifier: 0,
    looping: true,
    // #region docs:emitters:1
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.45, 18, 10),
        rate: 100,
        radialSpeed: 1.5,
        initialValues: {
          lifetime: 0.7,
          mass: 1,
          speed: 0.8,
          scale: new THREE.Vector3(0.32, 0.32, 0.32),
          color: 0xffffff,
          alpha: 0.9,
          velocity: new THREE.Vector3(0, 1.6, 0),
        },
      }),
    ],
    // #endregion docs:emitters:1
    // #region docs:modules:1
    modules: [
      new GasSimulation({
        supportSpatialEffects: true,
        collisionOptions: { surfaceThickness: 0.02, bakedFieldResolution: 32 },
        pressureIterations: 16,
        externalForce: new THREE.Vector3(0, 0.05, 0),
        densityDissipation: 0.35,
        temperatureDissipation: 1.2,
        colorDissipation: 0.9,
        velocityDissipation: 0.3,
        buoyancy: 2,
        weight: 0.08,
        sourceTemperature: 1,
        temperatureOverLifetime: time => 1 - time,
        // Mass emission per second and diffusivity in world units²/second.
        sourceStrength: 0.5,
        velocitySourceStrength: 0.0045,
        scalarDiffusion: 0.005,
        turbulenceNoiseStrength: 1.5,
        vorticityStrength: 10,

        turbulenceNoiseFrequency: 1.5,
        turbulenceNoiseSpeed: 0.7,
        turbulenceNoiseOctaves: 2,
        automaticPadding: true,
        spatialGridOptions: {
          brickSubdivisions: 3,
          cellSubdivisions: 3,
          // 8 / 64 = 0.125 world units per cell, independently of the initially compact domain.
          minVolumeQuality: 8,
          powerOfTwoBounds: true,
          autoExpand: false,
          shrinkDelay: 180,
        },
      }),
      new Collision({ lifetimeLoss: 1 }),
      new ForceOverLifetime({ force: new THREE.Vector3(0, 0.35, 0) }),
      new TransformByNoise({ strength: new THREE.Vector3(1.6, 0.25, 1.6), frequency: 0.9 }),
      new ScaleOverLifetime({
        scale: time => {
          const size = 1 - 0.8 * time;
          return new THREE.Vector3(size, size, size);
        }
      }),
      // Fade particle emission near the end of its lifetime.
      new ColorOverLifetime({ alpha: time => 1 - THREE.MathUtils.smoothstep(time, 0.65, 1) }),
    ],
    // #endregion docs:modules:1
    // #region docs:renderers:1
    renderers: [
      new VolumeRenderer({
        lightingGridOptions: { cellSize: 0.25, maxDistance: 16 },
        color: '#867979',
        opacity: 0.75,
        threshold: 0.025,
        range: 0.02,
        densityNoiseStrength: 2,
        densityNoiseContrast: 1,
        densityNoiseFrequency: 1,
        densityNoiseSpeed: 0.5,
        densityNoiseStretch: 0.125,
        densityNoiseStretchBySpeed: [0, 1],
        // Masked thin structures need finer ray sampling than the standard one-sample tier.
        samplesPerVoxel: 4,
        steps: 256,
      }),
    ],
    // #endregion docs:renderers:1
  });
  // #endregion docs:system:1
  system.name = 'Volumetric Smoke';
  return system;
}

/** @type {import('../types').ExampleMetadata} */
createVolumetricSmoke.metadata = {
  author: 'rzmay',
  id: 'volumetricSmoke',
  title: 'Volumetric Smoke',
  description: 'A continuous cloud of rolling warm-gray smoke with a subtle reddish tint.',
  tags: ['gas', 'smoke', 'plume', 'volume', 'webgpu'],
  previewSettings: { backend: 'webgpu', duration: 10, warmup: 60 },
};
