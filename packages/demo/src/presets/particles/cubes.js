import * as THREE from 'three';
import {
  ColorOverLifetime,
  Emitter,
  MeshRenderer,
  ParticleSystem,
  RotationOverLifetime,
  SpriteRenderer,
} from '@rzmps/rzmps';
import { Easing } from 'eaz';

export default async function createCubes() {
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
          lifetime: [4, 8],
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

    modules: [
      new RotationOverLifetime({
        angularVelocity: [new THREE.Vector3(5, 0, 1), new THREE.Vector3(-1, 0, -5)],
      }),
      new ColorOverLifetime({
        alpha: (t) => (1 - Easing.cubic.in(THREE.MathUtils.clamp(t, 0, 1)))
      })
    ],

    renderers: [
      new MeshRenderer({
        mesh: new THREE.Mesh(
          new THREE.BoxGeometry(0.25, 0.25, 0.25),
          new THREE.MeshStandardMaterial()
        ),
        castShadow: true,
        receiveShadow: true,
      }),
    ],
  });

  system.name = 'Spheres';
  system.position.set(0, 0, 0);

  return system;
}

createCubes.author = "rzmay";
createCubes.description = "Instanced mesh rendering with randomized cube particles and simple lifetime rotation and fade-out.";
