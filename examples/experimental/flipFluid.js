import * as THREE from 'three';
import {
  Emitter,
  EmissionShape,
  FLIPSimulation,
  ParticleSystem,
  SpriteRenderer,
  Textures,
} from '@rzmps/rzmps';

export default async function createFlipFluid() {
  // #region docs:modules:1
  const flip = new FLIPSimulation({
    bounds: new THREE.Box3(
      new THREE.Vector3(-3, -1, -3),
      new THREE.Vector3(3, 4, 3),
    ),
    boundsPadding: 0,
    automaticPadding: true,
    velocityPaddingLookahead: 0.15,
    spatialGridOptions: {
      brickSubdivisions: 2,
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
    maxParticles: 8000,
    duration: 14,
    looping: false,
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
      new SpriteRenderer(Textures.Circle, {
        material: 'lit',
        softParticleDistance: 0.4,
        materialOptions: {
          roughness: 0.25,
          metalness: 0,
        },
      }),
    ],
    // #endregion docs:renderers:1
  });
  // #endregion docs:system:1

  system.name = 'FLIP Fluid';
  system.position.set(0, 0, 0);

  return system;
}

createFlipFluid.author = "rzmay";

/** @type {import("../types").ExampleMetadata} */
export const metadata = {
  id: 'flipFluid',
  title: 'FLIP Fluid',
  description: 'Particle-carried fluid motion using the shared grid pressure solver.',
  tags: ['fluid', 'flip', 'webgpu'],
  category: 'effects',
};

createFlipFluid.description = metadata.description;
