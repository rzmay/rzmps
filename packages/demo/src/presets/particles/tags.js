import * as THREE from 'three';
import {
  Emitter,
  ParticleSystem,
  SpriteRenderer,
  Collision,
  MeshRenderer,
  RotationOverLifetime,
  ColorOverLifetime,
  ScaleOverLifetime,
  Textures,
} from '@rzmps/rzmps';
import { curvePresets } from '../curvePresets';

export default async function createTags() {
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
        tags: ['spheres', 'cubes'],
        tagSelection: 'distribute',
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

    modules: [
      new RotationOverLifetime({
        angularVelocity: [new THREE.Vector3(5, 0, 1), new THREE.Vector3(-1, 0, -5)],
        tags: 'cubes',
      }),
      new ColorOverLifetime({
        alpha: (t) => curvePresets.fadeOut.evaluate(t),
        tags: 'cubes',
      }),
      new ScaleOverLifetime({
        scale: (time) => {
          const size = curvePresets.grow.evaluate(time);
          return new THREE.Vector3(size, size, size);
        },
        tags: 'spheres'
      }),
      new Collision({ tags: 'spheres' })
    ],

    renderers: [
      new SpriteRenderer(Textures.Circle, {
        material: 'basic',
        tags: 'spheres',
        materialOptions: {
          roughness: 0.5,
          sphericalNormals: true,
          normalLighting: 1,
        },
        castShadow: true,
      }),
      new MeshRenderer({
        tags: 'cubes',
        mesh: new THREE.Mesh(
          new THREE.BoxGeometry(1, 1, 1),
          new THREE.MeshStandardMaterial()
        ),
        castShadow: true,
        receiveShadow: true,
      }),
    ],
  });

  system.name = 'Spheres';
  system.position.set(0, 1, 0);

  return system;
}
