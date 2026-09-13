import * as THREE from 'three';
import {
  Emitter,
  ParticleSystem,
  SpriteRenderer,
} from 'rzmps';
import circleSprite from 'url:../../assets/images/circle.png';

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
            new THREE.Vector3(0.4, 0.4, 0.4),
            new THREE.Vector3(1.0, 1.0, 1.0),
          ],
          alpha: 1,
        },
      }),
    ],

    modules: [],

    renderers: [
      new SpriteRenderer(circleSprite, {
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
