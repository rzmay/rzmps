import * as THREE from 'three';
import {
  Collision,
  Emitter,
  EmissionShape,
  FLIPSimulation,
  ForceOverLifetime,
  ParticleSystem,
  ScaleOverLifetime,
  SpriteRenderer,
  Textures,
} from '@rzmps/rzmps';

export default async function createFlipFluid() {
  const flip = new FLIPSimulation({
    bounds: new THREE.Box3(
      new THREE.Vector3(-4, -1.25, -4),
      new THREE.Vector3(4, 6.25, 4),
    ),
    spatialGrid: {
      brickSubdivisions: 2,
      cellSubdivisions: 3,
      powerOfTwoBounds: true,
      autoExpand: true,
    },
    pressureIterations: 14,
    externalForce: new THREE.Vector3(0, 0, 0),
    picRatio: 0.12,
  });

  const system = new ParticleSystem({
    duration: 10,
    looping: true,
    gravity: new THREE.Vector3(0, -2.2, 0),
    gravityModifier: 1,
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.45, 16, 10),
        rate: 155,
        radialSpeed: 0.5,
        initialValues: {
          lifetime: 4.6,
          mass: 1,
          speed: 1.25,
          scale: new THREE.Vector3(0.2, 0.2, 0.2),
          color: new THREE.Color('#7cc7ff'),
          alpha: 0.7,
          velocity: new THREE.Vector3(1.75, 3.05, 0.2),
        },
      }),
    ],
    modules: [
      flip,
      new Collision({
        bounce: 0.35,
        dampen: 0.15,
        radiusScale: 0.65,
      }),
      new ScaleOverLifetime({
        scale: (time) => {
          const size = 0.22 * (1 - time * 0.35);
          return new THREE.Vector3(size, size, size);
        },
      }),
    ],
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
  });

  system.name = 'FLIP Fluid';
  system.position.set(0, 0, 0);

  return system;
}

createFlipFluid.author = "rzmay";
createFlipFluid.description = "Particle-carried fluid motion using the shared grid pressure solver.";
