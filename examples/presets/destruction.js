import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  Collision,
  DecalRenderer,
  Emitter,
  EmissionShape,
  MaterialCopySampleMode,
  MaterialCopy,
  MaterialCopySource,
  MeshRenderer,
  ParticleSystem,
  RotationBySpeed,
  ColorOverLifetime,
} from '@rzmps/rzmps';

import { Easing } from 'eaz';
import impact1Normal from 'examples/assets/images/impact/512/T_concrete_impact_01_normal.PNG?url';
import impact1Opacity from 'examples/assets/images/impact/512/T_concrete_impact_01_opacity.PNG?url';
import impact1AO from 'examples/assets/images/impact/512/T_concrete_impact_01_ambientocclusion.PNG?url';
import impact1Roughness from 'examples/assets/images/impact/512/T_concrete_impact_01_roughness.PNG?url';
import impact2Normal from 'examples/assets/images/impact/512/T_concrete_impact_02_normal.PNG?url';
import impact2Opacity from 'examples/assets/images/impact/512/T_concrete_impact_02_opacity.PNG?url';
import impact2AO from 'examples/assets/images/impact/512/T_concrete_impact_02_ambientocclusion.PNG?url';
import impact2Roughness from 'examples/assets/images/impact/512/T_concrete_impact_02_roughness.PNG?url';
import impact3Normal from 'examples/assets/images/impact/512/T_concrete_impact_03_normal.PNG?url';
import impact3Opacity from 'examples/assets/images/impact/512/T_concrete_impact_03_opacity.PNG?url';
import impact3AO from 'examples/assets/images/impact/512/T_concrete_impact_03_ambientocclusion.PNG?url';
import impact3Roughness from 'examples/assets/images/impact/512/T_concrete_impact_03_roughness.PNG?url';
import impact4Normal from 'examples/assets/images/impact/512/T_concrete_impact_04_normal.PNG?url';
import impact4Opacity from 'examples/assets/images/impact/512/T_concrete_impact_04_opacity.PNG?url';
import impact4AO from 'examples/assets/images/impact/512/T_concrete_impact_04_ambientocclusion.PNG?url';
import impact4Roughness from 'examples/assets/images/impact/512/T_concrete_impact_04_roughness.PNG?url';
import impact5Normal from 'examples/assets/images/impact/512/T_concrete_impact_05_normal.PNG?url';
import impact5Opacity from 'examples/assets/images/impact/512/T_concrete_impact_05_opacity.PNG?url';
import impact5AO from 'examples/assets/images/impact/512/T_concrete_impact_05_ambientocclusion.PNG?url';
import impact5Roughness from 'examples/assets/images/impact/512/T_concrete_impact_05_roughness.PNG?url';
import impact6Normal from 'examples/assets/images/impact/512/T_concrete_impact_06_normal.PNG?url';
import impact6Opacity from 'examples/assets/images/impact/512/T_concrete_impact_06_opacity.PNG?url';
import impact6AO from 'examples/assets/images/impact/512/T_concrete_impact_06_ambientocclusion.PNG?url';
import impact6Roughness from 'examples/assets/images/impact/512/T_concrete_impact_06_roughness.PNG?url';
import destruction1 from 'examples/assets/models/Destruction_1.glb?url';
import destruction2 from 'examples/assets/models/Destruction_2.glb?url';
import destruction3 from 'examples/assets/models/Destruction_3.glb?url';
import destruction4 from 'examples/assets/models/Destruction_4.glb?url';
import destruction5 from 'examples/assets/models/Destruction_5.glb?url';
import cornellBoxScene from '../scenes/cornellBox';

async function loadFragments() {
  const loader = new GLTFLoader();
  const assets = await Promise.all(
    [destruction1, destruction2, destruction3, destruction4, destruction5].map(url => loader.loadAsync(url)),
  );
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
export default async function destructionPreset() {
  const textureLoader = new THREE.TextureLoader();

  // #region docs:renderers:3
  // Load each matching map bundle together, then choose one whole material per impact.
  const impactURLs = [
    {
      normalMap: impact1Normal,
      alphaMap: impact1Opacity,
      aoMap: impact1AO,
      roughnessMap: impact1Roughness,
    },
    {
      normalMap: impact2Normal,
      alphaMap: impact2Opacity,
      aoMap: impact2AO,
      roughnessMap: impact2Roughness,
    },
    {
      normalMap: impact3Normal,
      alphaMap: impact3Opacity,
      aoMap: impact3AO,
      roughnessMap: impact3Roughness,
    },
    {
      normalMap: impact4Normal,
      alphaMap: impact4Opacity,
      aoMap: impact4AO,
      roughnessMap: impact4Roughness,
    },
    {
      normalMap: impact5Normal,
      alphaMap: impact5Opacity,
      aoMap: impact5AO,
      roughnessMap: impact5Roughness,
    },
    {
      normalMap: impact6Normal,
      alphaMap: impact6Opacity,
      aoMap: impact6AO,
      roughnessMap: impact6Roughness,
    },
  ];
  const [fragments, impactTextures] = await Promise.all([
    loadFragments(),
    Promise.all(
      impactURLs.map(async urls => {
        const entries = await Promise.all(
          Object.entries(urls).map(async ([key, url]) => {
            const texture = await textureLoader.loadAsync(url);
            texture.colorSpace = THREE.NoColorSpace;
            texture.channel = 0;
            return [key, texture];
          }),
        );
        return Object.fromEntries(entries);
      }),
    ),
  ]);
  const impactMaterials = impactTextures.map(
    maps =>
      new THREE.MeshStandardMaterial({
        ...maps,
        normalScale: new THREE.Vector2(2, 2),
        roughness: 1,
        metalness: 0,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      }),
  );
  // #endregion docs:renderers:3

  const thicknesses = fragments
    .map(fragment => {
      fragment.geometry.computeBoundingBox();
      const size = fragment.geometry.boundingBox.getSize(new THREE.Vector3());
      return Math.min(size.x, size.y, size.z);
    })
    .sort((a, b) => a - b);
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
    renderers: [
      new MeshRenderer({
        geometry: new THREE.SphereGeometry(0.5, 12, 8),
        materialOptions: { color: '#888888', roughness: 0.25, metalness: 0.6 },
      }),
      new DecalRenderer(impactMaterials, {
        atlasOptions: { minCapacity: 4 },
        textureCopyQuality: 1,
        // The final opacity blend masks all damage lighting once, preserving soft edges.
        materialComposite: (source, dest) => ({
          color: source.color,
          opacity: `${source.opacity} * ${dest.opacity}`,
          normal: source.normal,
          roughness: `${source.roughness} * ${dest.roughness}`,
          metalness: source.metalness,
        }),
        materialCompositeGPU: (source, dest) => ({
          color: source.color,
          opacity: source.opacity.mul(dest.opacity),
          normal: source.normal,
          roughness: source.roughness.mul(dest.roughness),
          metalness: source.metalness,
        }),
        onSpawn: false,
        impulseThreshold: 4,
        rotation: [-Math.PI, Math.PI],
        size: 0.55,
        impulseAffectsSize: 0.3,
        onCollision: (hit, source, parameters) => ({
          size: parameters.size.clone().clampScalar(0.5, 1.4),
        }),
        depth: 0.06,
        maxDistance: 0.5,
        inheritScale: 0,
        inheritColor: 0,
        inheritAlpha: 0,
        lifetime: 60,
        maxDecals: 384,
        opacity: t => 1 - THREE.MathUtils.smoothstep(t, 0.75, 1),
      }),
    ],
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
      new MaterialCopy({ source: MaterialCopySource.Collision, sampleMode: MaterialCopySampleMode.UVPatch }),
      // Contact damping reduces sliding while allowing fragments to tumble and rebound.
      new Collision({ bounce: 0.3, dampen: [0.2, 0.5], radiusScale: collisionDiameter }),
      new RotationBySpeed({
        speedRange: [0.25, 0.5],
        angularVelocity: [new THREE.Vector3(), new THREE.Vector3(20, 40, 10)],
      }),
      new ColorOverLifetime({
        alpha: t => (t < 0.8 ? 1 : Easing.cubic.out(1 - (t - 0.8) * 5)),
      }),
    ],
    // #endregion docs:modules:2
    // #region docs:renderers:2
    // Neutral factors preserve the source appearance. Render each fragment only once.
    renderers: new MeshRenderer({
      mesh: fragments,
      atlasOptions: { minCapacity: 4 },
      textureCopyQuality: 1,
      maxParticles: 512,
      materialOptions: { roughness: 1, metalness: 1 },
    }),
    // #endregion docs:renderers:2
  });
  // #endregion docs:system:2

  // #region docs:system:3
  system.addSubSystem(debris, {
    emitOnCollision: true,
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
    impactMaterials.forEach(material => material.dispose());
    impactTextures.forEach(maps => Object.values(maps).forEach(texture => texture.dispose()));
    fragments.forEach(fragment => fragment.geometry.dispose());
    if (fragments.length) fragments[0].material.dispose();
  });

  system.name = 'Destruction';
  debris.name = 'Surface Fragments';

  return system;
}
destructionPreset.metadata = {
  author: 'rzmay',
  id: 'destruction',
  title: 'Destruction',
  tags: [
    'destruction',
    'collision',
    'debris',
    'meshes',
    'batching',
    'materials',
    'uv-patch',
    'decals',
    'compositing',
    'impulse',
    'effects',
  ],
  description: 'Metal ball impacts leave concrete cracks and fragments carrying the contacted surface UV footprint.',
  previewSettings: {
    // Matches ParticleSystem's default duration.
    duration: 10,
    scene: cornellBoxScene,
    warmup: 150,
    cameraPosition: [7, 6, 10],
    cameraTarget: [0, 1, 0],
  },
};
