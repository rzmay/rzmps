import * as THREE from 'three';
import {
  Emitter,
  ParticleSystem,
  SpriteRenderer,
  Textures,
} from '@rzmps/rzmps';

export default async function createSpheres() {
  const colors = new Set([
    new THREE.Color('#ff3333'),
    new THREE.Color('#33ff66'),
    new THREE.Color('#ffdd22'),
    new THREE.Color('#3388ff'),
  ]);

  const system = new ParticleSystem({
    duration: 10,
    looping: true,
    gravity: new THREE.Vector3(0, 0, 0),
    gravityModifier: 0,

    emitters: [
      new Emitter({
        rate: 12,
        radialSpeed: 1,
        initialValues: {
          lifetime: [6, 12],
          speed: 1,
          color: colors,
          scale: [
            new THREE.Vector3(0.1, 0.1, 0.1),
            new THREE.Vector3(0.25, 0.25, 0.25),
          ],
          alpha: 1,
        },
      }),
    ],

    modules: [],

    renderers: [
      new SpriteRenderer(Textures.Circle, {
        material: 'basic',

        materialOptions: {
          roughness: 0.5,
          sphericalNormals: true,
          normalLighting: 1,
        },
      }),
    ],
  });

  system.name = 'Spheres';
  system.position.set(0, 1, 0);

  return system;
}
