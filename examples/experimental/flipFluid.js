import * as THREE from 'three';
import {
  ColorOverLifetime,
  Emitter,
  EmissionShape,
  FLIPSimulation,
  ParticleSystem,
  ScaleOverLifetime,
  SpriteRenderer,
  SurfaceRenderer,
  Textures,
} from '@rzmps/rzmps';
import sprayAlpha from '../assets/images/spray_alpha.png?url';

export default async function createFlipFluid() {
  // #region docs:modules:1
  const flip = new FLIPSimulation({
    bounds: new THREE.Box3(
      new THREE.Vector3(-4, -4, -4),
      new THREE.Vector3(4, 4, 4),
    ),
    boundsPadding: 0,
    maxBounds: 16,
    automaticPadding: true,
    velocityPaddingLookahead: 0.15,
    spatialGridOptions: {
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
      new SurfaceRenderer({
        bounds: new THREE.Box3(new THREE.Vector3(-8, -8, -8), new THREE.Vector3(8, 8, 8)),
        voxelSize: 0.0625,
        maxActiveBricks: 2048,
        maxTriangles: 262144,
        spatialGridOptions: { brickSubdivisions: 3, cellSubdivisions: 3 },
        smoothingIterations: 4,
        smoothingStrength: 1,
        material: new THREE.MeshPhysicalMaterial({
          color: 'white', roughness: 0.055, metalness: 0,
          transmission: 0.9, thickness: 0.3, ior: 1.333,
          attenuationColor: new THREE.Color('#b7e4ee'), attenuationDistance: 3,
        }),
      }),
    ],
    // #endregion docs:renderers:1
  });
  // #endregion docs:system:1

  // #region docs:system:2
  const spray = new ParticleSystem({
    maxParticles: 1500,
    duration: 0,
    looping: true,
    gravity: new THREE.Vector3(0, -5.2, 0),
    gravityModifier: 1,
    // #region docs:emitters:2
    emitters: [new Emitter({
      source: EmissionShape.Sphere(0.015, 8, 4),
      rate: 8,
      radialSpeed: [0.1, 0.4],
      initialValues: {
        lifetime: [0.35, 0.7],
        scale: [0.12, 0.24],
        alpha: 0.7,
        rotation: [new THREE.Vector3(), new THREE.Vector3(0, 0, Math.PI * 2)],
      },
    })],
    // #endregion docs:emitters:2
    // #region docs:modules:3
    modules: [
      new ScaleOverLifetime({ scale: time => 1 - 0.7 * time }),
      new ColorOverLifetime({ alpha: time => 1 - time }),
    ],
    // #endregion docs:modules:3
    // #region docs:renderers:2
    renderers: [new SpriteRenderer(Textures.Default, {
      alphaMap: sprayAlpha,
      materialOptions: { depthWrite: false, blending: THREE.NormalBlending },
    })],
    // #endregion docs:renderers:2
  });
  // #endregion docs:system:2
  spray.name = 'Liquid Spray';
  system.addSubSystem(spray, {
    emitContinuous: true,
    ratio: 0.15,
    inheritVelocity: 1,
    inheritScale: 0,
    inheritLifetime: 0,
    inheritAlpha: 0,
    shouldEmitGPU: FLIPSimulation.SprayCondition({
      minimumSpeed: 1.5,
      minimumAge: 0.1,
      maximumNeighbors: 6,
      neighborRadius: 2,
    }),
  });

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
