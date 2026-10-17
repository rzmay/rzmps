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
    // #endregion docs:emitters:1

    // #region docs:modules:1
    modules: [],
    // #endregion docs:modules:1

    // #region docs:renderers:1
    renderers: [
      new SpriteRenderer(Textures.Circle, {
        material: 'lit',

        materialOptions: {
          roughness: 0.5,
          sphericalNormals: 1,
          normalLighting: 1,
        },
      }),
    ],
    // #endregion docs:renderers:1
  });
  // #endregion docs:system:1

  system.name = 'Spheres';
  system.position.set(0, 0, 0);

  return system;
}

createSpheres.author = "rzmay";

/** @type {import("./types").ExampleMetadata} */
export const metadata = {
  "id": "spheres",
  "title": "Spheres",
  "description": "Lit sprite particles with spherical normals for a 3D effect.",
  "tags": [
    "spheres"
  ],
  "category": "effects"
};

createSpheres.description = metadata.description;
