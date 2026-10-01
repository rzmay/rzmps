import * as THREE from 'three';
import {
  Boids,
  Emitter,
  EmissionShape,
  MeshRenderer,
  OrientToDirection,
  ParticleSystem,
} from '@rzmps/rzmps';

export default async function createBoids() {
  const flockColors = new Set([
    new THREE.Color('#7ce7ff'),
    new THREE.Color('#c7fff3'),
    new THREE.Color('#95ff7c'),
  ]);

  const hazardColors = new Set([
    new THREE.Color('#ff4c5f'),
    new THREE.Color('#ff9a4c'),
  ]);

  const flockSource = EmissionShape.Sphere(12, 32, 16);
  const hazardSource = EmissionShape.Torus(7.5, 0.45, 16, 48);

  const boids = new Boids({
    tags: 'boid',
    alignmentWeight: 1.55,
    cohesionWeight: 1.35,
    separationWeight: 2.4,
    affectorWeight: 2.2,
    affectorDistance: 1.8,
    steering: 3.75,
    particleAffectors: {
      hazard: {
        tags: 'boid',
        weight: Boids.BoidAffector.Weight.Obstacle,
        distance: 1.8,
      },
    },
  });

  const system = new ParticleSystem({
    duration: 24,
    looping: true,
    gravity: new THREE.Vector3(0, 0, 0),
    gravityModifier: 0,
    maxParticles: 700,

    emitters: [
      new Emitter({
        source: flockSource,
        rate: 38,
        radialSpeed: 0.9,
        tags: 'boid',
        initialValues: {
          lifetime: [9, 16],
          speed: [3.2, 4.8],
          color: flockColors,
          scale: [
            new THREE.Vector3(0.34, 0.34, 0.34),
            new THREE.Vector3(0.48, 0.48, 0.48),
          ],
          alpha: 0.88,
        },
      }),
      new Emitter({
        source: hazardSource,
        rate: 1,
        radialSpeed: 0.45,
        tags: 'hazard',
        initialValues: {
          lifetime: [14, 22],
          speed: [0.55, 0.9],
          color: hazardColors,
          scale: [
            new THREE.Vector3(0.65, 0.65, 0.65),
            new THREE.Vector3(1.05, 1.05, 1.05),
          ],
          alpha: 0.95,
        },
      }),
    ],

    modules: [
      boids,
      new OrientToDirection({
        axis: new THREE.Vector3(0, 1, 0),
      }),
    ],

    renderers: [
      new MeshRenderer({
        tags: 'boid',
        mesh: new THREE.Mesh(
          new THREE.ConeGeometry(0.32, 0.9, 12, 1),
          new THREE.MeshStandardMaterial({
            roughness: 0.52,
            metalness: 0.05,
            emissive: new THREE.Color('#071018'),
            emissiveIntensity: 0.18,
          }),
        ),
      }),
      new MeshRenderer({
        tags: 'hazard',
        mesh: new THREE.Mesh(
          new THREE.ConeGeometry(0.38, 1.05, 14, 1),
          new THREE.MeshStandardMaterial({
            roughness: 0.35,
            metalness: 0.05,
            emissive: new THREE.Color('#601018'),
            emissiveIntensity: 0.55,
          }),
        ),
      }),
    ],
  });

  system.name = 'Boids';
  system.position.set(0, 2, 0);

  return system;
}

createBoids.author = "rzmay";
createBoids.description = "Flocking particles using ParticleOctree aggregation, with red hazard particles acting as tagged particle affectors.";
