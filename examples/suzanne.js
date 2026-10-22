import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import {
  ColorOverLifetime,
  Emitter,
  EmissionShape,
  MeshRenderer,
  ParticleSystem,
  ScaleOverLifetime,
  SpriteRenderer,
  EmissionSource,
  Textures,
} from '@rzmps/rzmps';
import suzanneModel from '../apps/demo/src/assets/models/suzanne.glb?url';
import { Easing } from 'eaz';


export default async function createSuzanne() {
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

  // #region docs:system:1
  const suzanne = new ParticleSystem({
    duration: 10,
    looping: true,
    // #region docs:emitters:1
    emitters: [
      new Emitter({
        source: new EmissionShape({
          geometry: suzanneGeometry,
          source: EmissionSource.Surface
        }),
        rate: 256,
        radialSpeed: 1.1,
        initialValues: {
          lifetime: 2.2,
          speed: 0,
          scale: new THREE.Vector3(0.1125, 0.1125, 0.1125),
          color: new THREE.Color('#70d6ff'),
          alpha: 0.85,
          velocity: new THREE.Vector3(0, 0, 0),
        },
      }),
    ],
    // #endregion docs:emitters:1
    // #region docs:modules:1
    modules: [
      new ColorOverLifetime({
        color: new THREE.Color('#70d6ff'),
        alpha: (time) => (1 - Easing.cubic.in(THREE.MathUtils.clamp(time, 0, 1))),
      }),
    ],
    // #endregion docs:modules:1
    // #region docs:renderers:1
    renderers: [
      new SpriteRenderer(Textures.Circle, {
        material: 'lit',
      }),
    ],
    // #endregion docs:renderers:1
  });
  // #endregion docs:system:1

  suzanne.name = 'Suzanne';
  suzanne.position.set(0, 0, 0);
  return suzanne;
}

createSuzanne.author = "rzmay";

/** @type {import("./types").ExampleMetadata} */
export const metadata = {
  "id": "suzanne",
  "title": "Suzanne",
  "description": "Mesh-surface emission from a model with lit sprite rendering.",
  "tags": [
    "suzanne"
  ],
  "category": "effects"
};

createSuzanne.description = metadata.description;
