import * as THREE from 'three';
import {
  ColorOverLifetime,
  Emitter,
  MeshRenderer,
  ParticleSystem,
  SpriteRenderer,
} from '@rzmps/rzmps';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import suzanneModel from '../apps/demo/src/assets/models/suzanne.glb?url';
import { Easing } from 'eaz';


export default async function createSuzannes() {
  const gltf = await new GLTFLoader().loadAsync(suzanneModel);

  let suzanneGeometry = null;
  gltf.scene.traverse((child) => {
    if (!suzanneGeometry && child.isMesh) {
      suzanneGeometry = child.geometry.clone();
      suzanneGeometry.rotateX(-90);
    }
  });

  if (!suzanneGeometry) {
    throw new Error('suzanne.glb does not contain a mesh');
  }

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
        alignment: 1,
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
    // #endregion docs:emitters:1

    // #region docs:modules:1
    modules: [
      new ColorOverLifetime({
        alpha: (t) => (1 - Easing.cubic.in(THREE.MathUtils.clamp(t, 0, 1)))
      })
    ],
    // #endregion docs:modules:1

    // #region docs:renderers:1
    renderers: [
      new MeshRenderer({
        mesh: new THREE.Mesh(
          suzanneGeometry,
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

createSuzannes.author = "rzmay";

/** @type {import("./types").ExampleMetadata} */
export const metadata = {
  "id": "suzanneInstances",
  "title": "Suzanne Instances",
  "description": "Mesh instancing with Suzanne particles and randomized transforms.",
  "tags": [
    "suzanneInstances"
  ],
  "category": "effects"
};

createSuzannes.description = metadata.description;
