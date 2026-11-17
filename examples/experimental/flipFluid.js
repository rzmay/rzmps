import * as THREE from 'three';
import {
  ColorOverLifetime,
  Collision,
  Emitter,
  EmissionShape,
  FLIPSimulation,
  FluidBoundsPolicy,
  ParticleSystem,
  ScaleOverLifetime,
  SpriteRenderer,
  SurfaceRenderer,
  SurfaceAttachment,
  Textures,
} from '@rzmps/rzmps';
import sprayAlpha from '../assets/images/spray_alpha.png?url';

export default async function createFlipFluid() {
  // #region docs:modules:1
  const flip = new FLIPSimulation({
    // Use the same membership settings accepted by Three's collision backends.
    collisionOptions: {
      surfaceThickness: 0.02,
      bakedFieldResolution: 48,
    },
    boundsPolicy: FluidBoundsPolicy.Kill,
    automaticPadding: true,
    spatialGridOptions: {
      maxBounds: 16,
      brickSubdivisions: 3,
      cellSubdivisions: 4,
      powerOfTwoBounds: true,
      autoExpand: false,
      expansionHysteresis: 0.35,
    },
    pressureIterations: 28,
    externalForce: new THREE.Vector3(0, 0, 0),
    maxVelocity: 6,
    picRatio: 0.08,
    collisionIterations: 4,
    particleSeparation: 0.5,
    particleSpacing: 1.1,
  });
  // #endregion docs:modules:1

  const liquidSurface = new SurfaceRenderer({
    bounds: new THREE.Box3(new THREE.Vector3(-8, -8, -8), new THREE.Vector3(8, 8, 8)),
    voxelSize: 0.0625,
    spatialGridOptions: { brickSubdivisions: 3, cellSubdivisions: 3 },
    fieldSmoothingIterations: 1,
    fieldSmoothing: 0.2,
    fieldClosing: 0.1,
    anisotropy: 0.35,
    anisotropyMaxStretch: 1.5,
    smoothingIterations: 1,
    smoothingStrength: 1,
    material: new SurfaceRenderer.LiquidMaterial({
      color: 'white',
      // Keep this preset's appearance independent of the material's general-purpose defaults.
      flow: {
        gradient: ['#a8daed', '#f5fbff'],
        roughness: [0.025, 0.7],
        normalStrength: [0.045, 0.22],
        noiseFrequency: [3, 6],
        distortion: [0, 0.65],
        advection: [0.6, 0.6],
        velocityRange: [0.2, 3],
        vorticityRange: [0.5, 8],
      },
      transmission: 0.9, thickness: 0.3, ior: 1.333,
      attenuationColor: new THREE.Color('#b7e4ee'), attenuationDistance: 3,
    }),
  });

  // #region docs:system:1
  const system = new ParticleSystem({
    maxParticles: 32000,
    duration: 0,
    looping: true,
    gravity: new THREE.Vector3(0, -5.2, 0),
    gravityModifier: 1,
    // #region docs:emitters:1
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.18, 12, 8),
        rate: 450,
        radialSpeed: 0.04,
        initialValues: {
          lifetime: 60,
          mass: 1,
          speed: 1,
          scale: new THREE.Vector3(0.085, 0.085, 0.085),
          color: new THREE.Color('#7cc7ff'),
          alpha: 0.8,
          velocity: new THREE.Vector3(0.04, -0.3, 0.01),
        },
      }),
    ],
    // #endregion docs:emitters:1
    // #region docs:modules:2
    modules: [
      flip,
    ],
    // #endregion docs:modules:2
    // #region docs:renderers:1
    renderers: [
      liquidSurface,
    ],
    // #endregion docs:renderers:1
  });
  // #endregion docs:system:1

  // #region docs:system:2
  const spray = new ParticleSystem({
    maxParticles: 4000,
    duration: 0,
    looping: true,
    gravity: new THREE.Vector3(0, -5.2, 0),
    gravityModifier: 1,
    // #region docs:emitters:2
    emitters: [new Emitter({
      source: EmissionShape.Sphere(0.015, 8, 4),
      rate: 24,
      radialSpeed: [0.1, 0.4],
      initialValues: {
        lifetime: [0.5, 1],
        scale: [0.35, 0.6],
        color: new THREE.Color('white'),
        alpha: 0.12,
        rotation: [new THREE.Vector3(), new THREE.Vector3(0, 0, Math.PI * 2)],
        angularVelocity: [new THREE.Vector3(0, 0, -0.5), new THREE.Vector3(0, 0, 0.5)],
      },
    })],
    // #endregion docs:emitters:2
    // #region docs:modules:3
    modules: [
      new ScaleOverLifetime({ scale: time => 1 - 0.7 * time }),
      new ColorOverLifetime({ alpha: time => Math.min(1, time / 0.15) * (1 - time) }),
      // The soft sprite is larger than the droplet's collision footprint.
      new Collision({ lifetimeLoss: 1, radiusScale: 0.1 }),
    ],
    // #endregion docs:modules:3
    // #region docs:renderers:2
    renderers: [new SpriteRenderer(Textures.Default, {
      alphaMap: sprayAlpha,
      softParticleDistance: 0.2,
      materialOptions: { depthWrite: false, blending: THREE.AdditiveBlending },
    })],
    // #endregion docs:renderers:2
  });
  // #endregion docs:system:2
  spray.name = 'Liquid Spray';
  const sprayCondition = FLIPSimulation.SprayCondition({
    minimumSpeed: 0.8,
    minimumAge: 0.05,
    maximumNeighbors: 14,
    neighborRadius: 1.5,
  });
  // Reuse the fine liquid index instead of constructing a much coarser second neighborhood grid.
  sprayCondition.spatialGridOptions = { ...flip.spatialGridOptions };
  system.addSubSystem(spray, {
    emitContinuous: true,
    ratio: 0.4,
    inheritVelocity: 1,
    inheritScale: 0,
    inheritLifetime: 0,
    inheritAlpha: 0,
    inheritColor: 0,
    shouldEmitGPU: sprayCondition,
  });

  // Foam is a normal secondary system; only its motion module depends on liquid sampling.
  const foamTexture = createFoamTexture();
  const foam = new ParticleSystem({
    maxParticles: 6000, duration: 0, looping: true,
    gravityModifier: 0,
    emitters: [new Emitter({
      source: EmissionShape.Sphere(0.015, 8, 4), rate: 12,
      initialValues: {
        lifetime: [1.5, 3], scale: [0.06, 0.12], alpha: 0.22,
        color: new THREE.Color('#eef8f5'),
        rotation: [new THREE.Vector3(), new THREE.Vector3(0, 0, Math.PI * 2)],
        angularVelocity: [new THREE.Vector3(0, 0, -0.25), new THREE.Vector3(0, 0, 0.25)],
      },
    })],
    modules: [
      new SurfaceAttachment({ surface: liquidSurface, samplerGPU: liquidSurface.sampleSurfaceGPU,
        offset: 0.018, adhesion: 90, tangentialDrag: 2.5, inheritSurfaceVelocity: 1,
        detachDistance: 0.18, killOnDetach: true }),
      new ColorOverLifetime({ alpha: t => Math.min(1, t / 0.15) * (1 - t) }),
      new ScaleOverLifetime({ scale: t => 1 + 0.25 * t }),
    ],
    renderers: [new SpriteRenderer(foamTexture, { softParticles: true, softParticleDistance: 0.08,
      materialOptions: { depthWrite: false, blending: THREE.NormalBlending } })],
  });
  foam.name = 'Liquid Foam';
  const foamCondition = FLIPSimulation.FoamCondition({ minimumSpeed: 0.25,
    minimumNeighbors: 3, maximumNeighbors: 24, neighborRadius: 2 });
  foamCondition.spatialGridOptions = { ...flip.spatialGridOptions };
  system.addSubSystem(foam, { emitContinuous: true, ratio: 0.3, inheritVelocity: 1,
    inheritScale: 0, inheritLifetime: 0, inheritAlpha: 0, inheritColor: 0, shouldEmitGPU: foamCondition });
  foam.addEventListener('destroyed', () => foamTexture.dispose());

  system.name = 'FLIP Fluid';
  system.position.set(0, 0, 0);

  return system;
}

createFlipFluid.author = 'rzmay';

export const metadata = {
  id: 'flipFluid',
  title: 'FLIP Fluid',
  description: 'Particle-carried fluid motion using the shared grid pressure solver.',
  tags: ['fluid', 'flip', 'webgpu'],
  category: 'effects',
};

createFlipFluid.description = metadata.description;

createFlipFluid.metadata = { ...metadata, author: 'rzmay' };

/** Small irregular translucent bubble patch; deterministic and independent of image loading. */
function createFoamTexture() {
  const size = 64, data = new Uint8Array(size * size * 4);
  const bubbles = [[-0.3, 0, 0.37], [0.2, 0.25, 0.3], [0.32, -0.25, 0.33], [-0.1, -0.4, 0.2]];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + 0.5) / size * 2 - 1, v = (y + 0.5) / size * 2 - 1;
    let alpha = 0;
    for (const [cx, cy, radius] of bubbles) {
      const distance = Math.hypot(u - cx, v - cy) / radius;
      const ring = Math.exp(-(((distance - 0.78) / 0.22) ** 2));
      const center = Math.max(0, 1 - distance) * 0.25;
      alpha = Math.max(alpha, ring * 0.65 + center);
    }
    data.set([255, 255, 255, Math.round(Math.min(1, alpha) * 255)], (x + y * size) * 4);
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
