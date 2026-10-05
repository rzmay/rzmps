import * as THREE from 'three';
import {
  Collision,
  Emitter,
  EmissionShape,
  ParticleSystem,
  SpriteRenderer,
  Textures,
} from '@rzmps/rzmps';

export default async function createCollision() {
  const collision = new ParticleSystem({
    duration: 5,
    looping: true,
    gravityModifier: 1,
    emitters: [
      new Emitter({
        source: new EmissionShape({
          geometry: new THREE.SphereGeometry(0.25, 16, 12),
        }),
        rate: 30,
        radialSpeed: [1, 5],
        initialValues: {
          lifetime: 8,
          scale: new THREE.Vector3(0.125, 0.125, 0.125),
          mass: 1,
          color: [
            new THREE.Color('#ff6633'),
            new THREE.Color('#ffd166'),
          ],
        },
      }),
    ],
    modules: [
      new Collision({
        bounce: 0.75,
        dampen: 0.05,
        radiusScale: 1,
        applyImpulses: true,
      }),
    ],
    renderers: [
      new SpriteRenderer(Textures.Circle, {
        material: 'lit',
        castShadow: true,

        materialOptions: {
          roughness: 0.5,
          sphericalNormals: 1,
          normalLighting: 1,
        },
      }),
    ],
  });

  collision.name = 'Collision';
  collision.position.set(0, 0, 0);

  return collision;
}

createCollision.author = "rzmay";
createCollision.description = "Particle collision with automatic mesh detection and sorting between static and dynamic objects for optimizing octree rebuilds. Alternatively Jolt, Rapier, and Ammo can be used as external physics backends, allowing particles to affect other physics objects in the scene.";
