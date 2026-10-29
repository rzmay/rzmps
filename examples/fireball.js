import * as THREE from 'three';
import {
  ColorOverLifetime,
  DecalRenderer,
  Emitter,
  EmissionShape,
  ForceOverLifetime,
  LightRenderer,
  ParticleSystem,
  RotationOverLifetime,
  ScaleOverLifetime,
  SpriteRenderer,
  Textures,
  TransformByNoise,
  VelocityOverLifetime,
} from '@rzmps/rzmps';
import fireballSprite from '../apps/demo/src/assets/images/fireball_tile_5x4_n20.png?url';
import warpNormal from '../apps/demo/src/assets/images/warp_norm.jpg?url';
import scorchTexture from '../apps/demo/src/assets/images/scorch.png?url';
import { Easing } from 'eaz';

export default async function createFireball() {
  const textureLoader = new THREE.TextureLoader();
  const heatDistortion = textureLoader.load(warpNormal);
  const scorchMap = textureLoader.load(scorchTexture);
  scorchMap.colorSpace = THREE.SRGBColorSpace;
  const scorchMaterial = new THREE.MeshBasicMaterial({ map: scorchMap });

  // #region docs:system:1
  const fireball = new ParticleSystem({
    duration: 1.25,
    looping: true,
    // #region docs:emitters:1
    emitters: [
      new Emitter({
        source: new EmissionShape({
          geometry: new THREE.SphereGeometry(0.2, 16, 12),
        }),
        rate: 0,
        bursts: [{ time: 0, count: 5 }],
        initialValues: {
          lifetime: 0.6,
          speed: 1,
          scale: 2.5,
          color: ['#ffffff', '#ffd166'],
          rotation: [-90, 90],
          alpha: 1,
          velocity: new THREE.Vector3(0, 0, 0),
          radial: 0.45,
        },
      }),
    ],
    // #endregion docs:emitters:1
    // #region docs:modules:1
    modules: [
      new ScaleOverLifetime({
        scale: (time) => {
          const size = (0.35 + (1.8 - 0.35) * time);
          return size;
        },
      }),
      new ColorOverLifetime({
        color: '#fff2e8',
        alpha: (time) => (1 - Easing.cubic.in(THREE.MathUtils.clamp(time, 0, 1))),
      }),
    ],
    // #endregion docs:modules:1
    // #region docs:renderers:1
    renderers: [
      new SpriteRenderer(fireballSprite, {
        gridSize: { x: 5, y: 4 },
        frames: 20,
        fps: 30,
        softParticleDistance: 1,
      }),
      new LightRenderer({
        count: 18,
        ratio: 0.3,
        randomDistribution: true,
        inheritParticleColor: true,
        sizeAffectsRange: true,
        alphaAffectsIntensity: true,
        brightness: 5,
        rangeMultiplier: 3,
        lightOptions: {
          color: '#ffae97',
          intensity: 1,
          distance: 8,
          decay: 2,
        },
      }),
      new DecalRenderer(scorchMaterial, {
        onSpawn: false,
        continuousRate: 4,
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
        maxDecals: 128,
      }),
    ],
    // #endregion docs:renderers:1
  });
  // #endregion docs:system:1

  fireball.addSubSystem(createHeatDistortion(Textures.Simple, heatDistortion), {
    inheritScale: 0,
    inheritLifetime: 0,
    inheritColor: 0,
    inheritAlpha: 0,
    inheritMass: 0,
    inheritVelocity: 0.5,
    emitOnSpawn: true,
    ratio: 0.55,
  });

  fireball.addEventListener('destroyed', () => {
    scorchMaterial.dispose();
    scorchMap.dispose();
  });
  fireball.name = 'Fireball';
  fireball.position.set(0, 0, 0);

  return fireball;
}

createFireball.author = "rzmay";

function createHeatDistortion(alphaMap, distortionMap) {
  // #region docs:system:2
  return new ParticleSystem({
    duration: 1,
    looping: true,
    // #region docs:emitters:2
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.05, 8, 6),
        bursts: [{ time: 0, count: 5 }],
        radialSpeed: 2,
        initialValues: {
          lifetime: 0.5,
          scale: 6,
          velocity: new THREE.Vector3(0, 1.35, 0),
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
      new ForceOverLifetime({
        force: new THREE.Vector3(0, 0.5, 0),
      }),
      new TransformByNoise({
        strength: new THREE.Vector3(0.55, 0.3, 0.55),
        frequency: 1.6,
      }),
      new ScaleOverLifetime({
        scale: (time) => 2 * Easing.cubic.out(time),
      }),
      new ColorOverLifetime({
        alpha: (time) =>
          ((time) < 0.2 ? (time) / 0.2 : (time) < 0.75
            ? 1 - 0.15 * (((time) - 0.2) / 0.55)
            : 0.85 * (1 - (((time) - 0.75) / 0.25))),
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
          opacity: 0.3,
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
  "id": "fireball",
  "title": "Fireball",
  "description":
    "Burst emission, animated sprite growth, particle lights, heat distortion, and persistent radial scorch marks.",
  "tags": [
    "fireball"
  ],
  "category": "effects"
};

createFireball.description = metadata.description;
