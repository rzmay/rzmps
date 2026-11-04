import * as THREE from 'three';
import {
  Collision, DecalRenderer, Emitter, EmissionShape, ParticleSystem, SpriteRenderer, Textures,
} from '@rzmps/rzmps';
import splatterTexture from '../apps/demo/src/assets/images/splat2.png?url';
import splatterNormal from '../apps/demo/src/assets/images/splat2_norm.jpg?url';

export default async function createSplatter() {
  const textureLoader = new THREE.TextureLoader();
  const paintMap = textureLoader.load(splatterTexture);
  paintMap.colorSpace = THREE.SRGBColorSpace;
  const normalMap = textureLoader.load(splatterNormal);
  const paint = new THREE.MeshStandardMaterial({
    map: paintMap,
    normalMap,
    normalScale: new THREE.Vector2(2, 2),
    color: '#ffffff',
    roughness: 0.25,
    metalness: 0,
  });
  const colors = new Set([
    new THREE.Color('#ff3355'),
    new THREE.Color('#33dd66'),
    new THREE.Color('#ffcc22'),
    new THREE.Color('#3388ff'),
    new THREE.Color('#bb44ff'),
  ]);
  // #region docs:system:1
  const system = new ParticleSystem({
    duration: 8,
    looping: true,
    gravityModifier: 1,
    // #region docs:emitters:1
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.12),
        rate: 5,
        radialSpeed: 3,
        initialValues: {
          position: new THREE.Vector3(0, 3.5, 0),
          velocity: new THREE.Vector3(0, 1.5, 0),
          lifetime: 8,
          scale: new THREE.Vector3(0.2, 0.2, 0.2),
          color: colors,
          rotation: [new THREE.Vector3(), new THREE.Vector3(0, 0, Math.PI * 2)],
        },
      }),
    ],
    // #endregion docs:emitters:1
    // #region docs:modules:1
    modules: [new Collision({ lifetimeLoss: 1 })],
    // #endregion docs:modules:1
    // #region docs:renderers:1
    renderers: [
      new SpriteRenderer(Textures.Circle, {
        material: 'lit',
        materialOptions: {
          roughness: 0.95,
          metalness: 0,
          sphericalNormals: 1,
          normalLighting: 1,
        },
      }),
      new DecalRenderer(paint, {
        onSpawn: false,
        onCollision: true,
        // Backends without mesh identity search opposite the collision normal, including on walls.
        maxDistance: 1,
        depth: 0.08,
        size: 5,
        inheritColor: 1,
        inheritScale: 1,
        inheritAlpha: 1,
        lifetime: 90,
        opacity: (t) => 1 - THREE.MathUtils.smoothstep(t, 0.85, 1),
        maxDecals: 512,
      }),
    ],
    // #endregion docs:renderers:1
  });
  // #endregion docs:system:1
  system.name = 'Splatter';
  system.addEventListener('destroyed', () => {
    paint.dispose();
    paintMap.dispose();
    normalMap.dispose();
  });
  return system;
}

createSplatter.author = 'rzmay';

/** @type {import('./types').ExampleMetadata} */
export const metadata = {
  id: 'splatter',
  title: 'Splatter',
  // eslint-disable-next-line max-len -- Documentation discovery requires a single literal description.
  description: 'Matte, multicolored paintballs leave long-lived splatters matching their color and size, with randomized surface rotation. Select a scene with collision geometry, such as Checkerboard.',
  tags: ['splatter', 'paintballs', 'decals', 'collision'],
  category: 'effects',
};
createSplatter.description = metadata.description;
