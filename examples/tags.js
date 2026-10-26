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
import { Easing } from 'eaz';

export default async function createTags() {
  const colors = new Set([
    '#ff3333',
    '#33ff66',
    '#ffdd22',
    '#3388ff',
  ]);

  // #region docs:system:1
  const system = new ParticleSystem({
    duration: 10,
    looping: true,
    gravity: new THREE.Vector3(0, 0, 0),
    gravityModifier: 0,

    // #region docs:emitters:1
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
            0.1,
            0.25,
          ],
          alpha: 1,
        },
      }),
    ],
    // #endregion docs:emitters:1

    // #region docs:modules:1
    modules: [
      new RotationOverLifetime({
        angularVelocity: [new THREE.Vector3(5, 0, 1), new THREE.Vector3(-1, 0, -5)],
        tags: 'cubes',
      }),
      new ColorOverLifetime({
        alpha: (t) => (1 - Easing.cubic.in(THREE.MathUtils.clamp(t, 0, 1))),
        tags: 'cubes',
      }),
      new ScaleOverLifetime({
        scale: (time) => {
          const size = (0.35 + (1.8 - 0.35) * time);
          return size;
        },
        tags: 'spheres'
      }),
      new Collision({ tags: 'spheres' })
    ],
    // #endregion docs:modules:1

    // #region docs:renderers:1
    renderers: [
      new SpriteRenderer(Textures.Circle, {
        material: 'lit',
        tags: 'spheres',
        materialOptions: {
          roughness: 0.5,
          sphericalNormals: 1,
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
    // #endregion docs:renderers:1
  });
  // #endregion docs:system:1

  system.name = 'Spheres';
  system.position.set(0, 0, 0);

  return system;
}

createTags.author = "rzmay";

/** @type {import("./types").ExampleMetadata} */
export const metadata = {
  "id": "tags",
  "title": "Cubes and Spheres",
  "description": "Tag-based module and renderer filtering by mixing cubes and spheres in one particle system.",
  "tags": [
    "tags"
  ],
  "category": "effects"
};

createTags.description = metadata.description;
