import * as THREE from 'three';
import {
  Collision,
  Emitter,
  EmissionShape,
  MaterialCopySampleMode,
  MeshRenderer,
  ParticleSystem,
  SpriteRenderer,
  Textures,
} from '@rzmps/rzmps';

/** Metal Balls-style impacts. Options also allow isolated sprite and sampling-mode comparisons. */
export default async function createMaterialCopy({
  sampleMode = MaterialCopySampleMode.UVPatch,
  sprites = false,
} = {}) {
  // #region docs:system:1
  const system = new ParticleSystem({
    gpuProcessing: true,
    // #region docs:emitters:1
    emitters: new Emitter({
      source: EmissionShape.Sphere(0.3),
      rate: 5,
      radialSpeed: [0.2, 1],
      initialValues: {
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
    // #region docs:emitters:2
    emitters: new Emitter({
      source: EmissionShape.Sphere(0.02),
      rate: 0,
      bursts: [{ time: 0, count: 10 }],
      radialSpeed: [1, 3],
      initialValues: {
        lifetime: [0.8, 1.5],
        scale: [0.2, 0.4],
      },
    }),
    // #endregion docs:emitters:2
    // #region docs:renderers:2
    // Neutral factors preserve the source appearance. Render each fragment only once.
    renderers: sprites
      ? new SpriteRenderer(Textures.Circle, {
        material: 'lit',
        materialCopySampleMode: sampleMode,
        materialOptions: { roughness: 1, metalness: 1 },
      })
      : new MeshRenderer({
        geometry: new THREE.BoxGeometry(1, 0.3, 1),
        materialCopySampleMode: sampleMode,
        materialOptions: { roughness: 1, metalness: 1 },
      }),
    // #endregion docs:renderers:2
  });
  // #endregion docs:system:2

  system.addSubSystem(debris, {
    emitOnCollision: true,
    copyCollisionMaterial: true,
    inheritScale: 0,
    inheritColor: 0,
    inheritLifetime: 0,
    inheritVelocity: 0,
    impulseAffectsAlignment: true,
    impulseThreshold: 0.5,
  });

  system.name = 'Material Copy';
  debris.name = sprites ? 'Surface Sprites' : 'Surface Fragments';

  return system;
}

createMaterialCopy.author = 'rzmay';
export const metadata = {
  id: 'materialCopy',
  title: 'Material Copy',
  category: 'effects',
  tags: ['collision', 'materials'],
  description: 'Metal ball impacts emit fragments that inherit the collided surface material and UV footprint.',
};
createMaterialCopy.description = metadata.description;
