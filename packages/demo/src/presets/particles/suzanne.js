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
import suzanneModel from '../../assets/models/suzanne.glb?url';
import { curvePresets } from '../curvePresets';


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

  const suzanne = new ParticleSystem({
    duration: 10,
    looping: true,
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
    modules: [
      new ColorOverLifetime({
        color: new THREE.Color('#70d6ff'),
        alpha: (time) => curvePresets.fadeOut.evaluate(time),
      }),
    ],
    renderers: [
      new SpriteRenderer(Textures.Circle, {
        material: 'basic',
      }),
    ],
  });

  suzanne.name = 'Suzanne';
  suzanne.position.set(0, 2.2, 0);
  return suzanne;
}
