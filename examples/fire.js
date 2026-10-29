import * as THREE from 'three';
import {
  ColorOverLifetime,
  DecalRenderer,
  Emitter,
  EmissionShape,
  EmissionSource,
  ForceOverLifetime,
  LightRenderer,
  LimitVelocityOverLifetime,
  ParticleSystem,
  RotationOverLifetime,
  ScaleOverLifetime,
  SpriteRenderer,
  TransformByNoise,
  VelocityOverLifetime,
  Textures,
  Module,
} from '@rzmps/rzmps';
import fireSprite from '../apps/demo/src/assets/images/fire_tile_8x4_n32.png?url';
import warpNormal from '../apps/demo/src/assets/images/warp_norm.jpg?url';
import scorchTexture from '../apps/demo/src/assets/images/scorch.png?url';
import { Easing } from 'eaz';

export default async function createFire() {
  const textureLoader = new THREE.TextureLoader();
  const heatDistortion = textureLoader.load(warpNormal);
  const scorchMap = textureLoader.load(scorchTexture);
  scorchMap.colorSpace = THREE.SRGBColorSpace;
  const scorchMaterial = new THREE.MeshBasicMaterial({ map: scorchMap });

  // #region docs:system:1
  const fire = new ParticleSystem({
    duration: 10,
    looping: true,
    // #region docs:emitters:1
    emitters: [
      new Emitter({
        source: new EmissionShape({
          geometry: new THREE.ConeGeometry(1, 1.7, 24),
          source: EmissionSource.Surface,
        }),
        rate: 90,
        radialSpeed: 0.2,
        initialValues: {
          lifetime: 1.35,
          speed: 1.2,
          scale: 2.5,
          color: ['#ff9c88', '#ffd47f'],
          alpha: 0.95,
          velocity: new THREE.Vector3(0, 2.2, 0),
        },
      }),
    ],
    // #endregion docs:emitters:1
    // #region docs:modules:1
    modules: [
      new VelocityOverLifetime({
        linear: new THREE.Vector3(0, 0.25, 0),
      }),
      new TransformByNoise({
        strength: 2.1,
        frequency: 1.35,
      }),
      new ForceOverLifetime({
        force: new THREE.Vector3(0, 0.5, 0),
      }),
      new ScaleOverLifetime({
        scale: (time) => {
          const size = (1.3 + (0.2 - 1.3) * time);
          return size;
        },
      }),
      new ColorOverLifetime({
        color: '#ffffff',
        alpha: (time) =>
          ((time) < 0.2 ? (time) / 0.2 : (time) < 0.75
            ? 1 - 0.15 * (((time) - 0.2) / 0.55)
            : 0.85 * (1 - (((time) - 0.75) / 0.25))),
      }),
      new RotationOverLifetime({
        angularVelocity: [new THREE.Vector3(-0.5, 0, 0), new THREE.Vector3(0.5, 0, 0)],
      }),
    ],
    // #endregion docs:modules:1
    // #region docs:renderers:1
    renderers: [
      new SpriteRenderer(fireSprite, {
        gridSize: { x: 8, y: 4 },
        frames: 32,
        fps: 24,
        softParticleDistance: 1,
      }),
      new LightRenderer({
        count: 18,
        ratio: 0.3,
        randomDistribution: true,
        inheritParticleColor: true,
        sizeAffectsRange: true,
        alphaAffectsIntensity: true,
        brightness: 1.8,
        rangeMultiplier: 3,
        lightOptions: {
          color: '#ffb570',
          intensity: 1,
          distance: 8,
          decay: 2,
        },
      }),
      new DecalRenderer(scorchMaterial, {
        onSpawn: false,
        continuousRate: 1.5,
        direction: (particle) => DecalRenderer.Radial(24)(particle),
        maxDistance: 3,
        depth: 0.06,
        size: 2.5,
        inheritColor: 0,
        inheritScale: 0,
        inheritAlpha: 0,
        lifetime: 8,
        opacity: (t) => 0.035 * THREE.MathUtils.smoothstep(t, 0, 0.01)
          * (1 - THREE.MathUtils.smoothstep(t, 0.6, 1)),
        maxDecals: 384,
      }),
    ],
    // #endregion docs:renderers:1
  });
  // #endregion docs:system:1

  fire.addSubSystem(createHeatDistortion(Textures.Simple, heatDistortion, {
    rate: 4,
    scale: 4,
    velocity: 0,
    lifetime: 1,
  }), {
    inheritScale: 0,
    inheritLifetime: 0,
    inheritColor: 0,
    inheritAlpha: 0,
    inheritMass: 0,
    // inheritVelocity: 0.35,
    ratio: 0.5,
  });

  fire.addEventListener('destroyed', () => {
    scorchMaterial.dispose();
    scorchMap.dispose();
  });
  fire.name = 'Fire';
  fire.position.set(0, 0, 0);

  return fire;
}

createFire.author = "rzmay";

function createHeatDistortion(alphaMap, distortionMap, options) {
  // #region docs:system:2
  return new ParticleSystem({
    duration: 1,
    looping: true,
    // #region docs:emitters:2
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.05, 8, 6),
        rate: options.rate,
        radialSpeed: 1,
        initialValues: {
          lifetime: options.lifetime,
          scale: options.scale,
          velocity: new THREE.Vector3(0, options.velocity, 0),
          color: '#ffffff',
          rotation: [-Math.PI, Math.PI],
        },
      }),
    ],
    // #endregion docs:emitters:2
    // #region docs:modules:2
    modules: [
      new VelocityOverLifetime({
        linear: new THREE.Vector3(0, 0.5, 0),
      }),
      new TransformByNoise({
        strength: new THREE.Vector3(0.65, 0.35, 0.65),
        frequency: 1.7,
      }),
      new ScaleOverLifetime({
        scale: (time) => {
          const size = (0.35 + (1.8 - 0.35) * time) * (1 - Easing.cubic.in(THREE.MathUtils.clamp(time, 0, 1)));
          return size;
        },
      }),
      new ColorOverLifetime({
        alpha: (time) => Easing.cubic.in(THREE.MathUtils.clamp(time * 5, 0,
          1)) * (1 - Easing.cubic.in(THREE.MathUtils.clamp((time - 0.8) * 5, 0, 1))),
      }),
      new RotationOverLifetime({
        angularVelocity: [-0.45, 0.45],
      }),
    ],
    // #endregion docs:modules:2
    // #region docs:renderers:2
    renderers: [
      new SpriteRenderer(Textures.Default, {
        alphaMap,
        softParticleDistance: 2.5,
        materialOptions: {
          transmission: 1,
          distortionMap,
          distortionStrength: 0.05,
          depthWrite: false,
        },
      }),
    ],
    // #endregion docs:renderers:2
  });
  // #endregion docs:system:2
}

/** @type {import("./types").ExampleMetadata} */
export const metadata = {
  "id": "fire",
  "title": "Fire",
  "description":
    "Sprite-sheet flames, particle lights, heat distortion, and persistent textured scorch marks on nearby surfaces.",
  "tags": [
    "fire"
  ],
  "category": "effects"
};

createFire.description = metadata.description;
