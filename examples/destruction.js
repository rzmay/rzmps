import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  Collision,
  Emitter,
  EmissionShape,
  MaterialCopySampleMode,
  MeshRenderer,
  ParticleSystem,
  RotationBySpeed,
  ColorOverLifetime,
} from '@rzmps/rzmps';

import { Easing } from 'eaz';
import destruction1 from '../apps/demo/src/assets/models/Destruction_1.glb?url';
import destruction2 from '../apps/demo/src/assets/models/Destruction_2.glb?url';
import destruction3 from '../apps/demo/src/assets/models/Destruction_3.glb?url';
import destruction4 from '../apps/demo/src/assets/models/Destruction_4.glb?url';
import destruction5 from '../apps/demo/src/assets/models/Destruction_5.glb?url';

async function loadFragments() {
  const loader = new GLTFLoader();
  const assets = await Promise.all([destruction1, destruction2, destruction3, destruction4, destruction5]
    .map(url => loader.loadAsync(url)));
  const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 1 });
  const fragments = [];
  const sourceMaterials = new Set();

  for (const asset of assets) {
    asset.scene.updateMatrixWorld(true);
    asset.scene.traverse(object => {
      if (!object.isMesh) return;
      // Bake authored transforms, retaining the small model dimensions and pivot.
      const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld);
      fragments.push(new THREE.Mesh(geometry, material));
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach(source => sourceMaterials.add(source));
    });
  }
  sourceMaterials.forEach(source => source.dispose());
  return fragments;
}

/** Metal ball impacts emit mesh fragments using UV patches from the contacted surface. */
export default async function createDestruction() {
  const fragments = await loadFragments();
  const thicknesses = fragments.map(fragment => {
    fragment.geometry.computeBoundingBox();
    const size = fragment.geometry.boundingBox.getSize(new THREE.Vector3());
    return Math.min(size.x, size.y, size.z);
  }).sort((a, b) => a - b);
  // Collision uses a sphere; use representative rock thickness rather than the old unit-sized geometry.
  const collisionDiameter = thicknesses[Math.floor(thicknesses.length / 2)] ?? 0.7;

  // #region docs:system:1
  const system = new ParticleSystem({
    gpuProcessing: true,
    gravityModifier: 1,
    // #region docs:emitters:1
    emitters: new Emitter({
      source: EmissionShape.Sphere(0.3),
      rate: 3,
      radialSpeed: [2, 4],
      initialValues: {
        position: new THREE.Vector3(0, 3, 0),
        velocity: new THREE.Vector3(0, -2, 0),
        lifetime: 4,
        scale: 0.16,
        mass: 1,
      },
    }),
    // #endregion docs:emitters:1
    // #region docs:modules:1
    modules: new Collision({ bounce: 0.55, dampen: 0.1 }),
    // #endregion docs:modules:1
    // #region docs:renderers:1
    renderers: new MeshRenderer({
      geometry: new THREE.SphereGeometry(0.5, 12, 8),
      materialOptions: { color: '#888888', roughness: 0.25, metalness: 0.6 },
    }),
    // #endregion docs:renderers:1
  });
  // #endregion docs:system:1

  // #region docs:system:2
  const debris = new ParticleSystem({
    gpuProcessing: true,
    duration: 0.05,
    looping: false,
    maxParticles: 512,
    gravityModifier: 1,
    // #region docs:emitters:2
    emitters: new Emitter({
      source: EmissionShape.Sphere(0.02),
      rate: 0,
      bursts: [{ time: 0, count: [6, 10] }],
      radialSpeed: [0.25, 1.5],
      initialValues: {
        lifetime: [2, 3],
        mass: 1,
        scale: 1,
      },
    }),
    // #endregion docs:emitters:2
    // #region docs:modules:2
    modules: [
      // Contact damping reduces sliding while allowing fragments to tumble and rebound.
      new Collision({ bounce: 0.3, dampen: 0.3, radiusScale: collisionDiameter }),
      new RotationBySpeed({
        speedRange: [0.1, 0.5],
        angularVelocity: [new THREE.Vector3(), new THREE.Vector3(20, 40, 10)],
      }),
      new ColorOverLifetime({
        alpha: (t) => t < 0.8 ? 1 : Easing.cubic.out(1 - ((t - 0.8) * 5))
      })
    ],
    // #endregion docs:modules:2
    // #region docs:renderers:2
    // Neutral factors preserve the source appearance. Render each fragment only once.
    renderers: new MeshRenderer({
      mesh: fragments,
      maxParticles: 512,
      materialCopySampleMode: MaterialCopySampleMode.UVPatch,
      materialOptions: { roughness: 1, metalness: 1 },
    }),
    // #endregion docs:renderers:2
  });
  // #endregion docs:system:2

  // #region docs:system:3
  system.addSubSystem(debris, {
    emitOnCollision: true,
    copyCollisionMaterial: true,
    inheritScale: 0,
    inheritColor: 0,
    inheritLifetime: 0,
    inheritVelocity: 0,
    impulseAffectsCount: 0.5,
    impulseAffectsSpeed: 0.45,
    impulseAffectsAlignment: true,
    impulseThreshold: 0.5,
  });
  // #endregion docs:system:3

  system.addEventListener('destroyed', () => {
    fragments.forEach(fragment => fragment.geometry.dispose());
    if (fragments.length) fragments[0].material.dispose();
  });

  system.name = 'Destruction';
  debris.name = 'Surface Fragments';

  return system;
}

createDestruction.author = 'rzmay';
export const metadata = {
  id: 'destruction',
  title: 'Destruction',
  category: 'effects',
  tags: ['collision', 'materials'],
  description: 'Metal ball impacts emit fragments that inherit the collided surface material and UV footprint.',
};
createDestruction.description = metadata.description;
