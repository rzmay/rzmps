import * as THREE from 'three';
import {
  ColorOverLifetime,
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
import fireSprite from '../../assets/images/fire_tile_8x4_n32.png?url';
import warpNormal from '../../assets/images/warp_norm.jpg?url';
import { Easing } from 'eaz';

export default async function createFire() {
  const textureLoader = new THREE.TextureLoader();
  const heatDistortion = textureLoader.load(warpNormal);

  const fire = new ParticleSystem({
    duration: 10,
    looping: true,
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
          scale: new THREE.Vector3(2.5, 2.5, 2.5),
          color: [new THREE.Color('#ff9c88'), new THREE.Color('#ffd47f')],
          alpha: 0.95,
          velocity: new THREE.Vector3(0, 2.2, 0),
        },
      }),
    ],
    modules: [
      new VelocityOverLifetime({
        linear: new THREE.Vector3(0, 0.25, 0),
      }),
      new TransformByNoise({
        strength: new THREE.Vector3(2.1, 2.1, 2.1),
        frequency: 1.35,
      }),
      new ForceOverLifetime({
        force: new THREE.Vector3(0, 0.35, 0),
      }),
      new LimitVelocityOverLifetime({
        limit: new THREE.Vector3(12, 12, 12),
        drag: 0.3,
        multiplyDragByVelocity: true,
      }),
      new ScaleOverLifetime({
        scale: (time) => {
          const size = (1.3 + (0.2 - 1.3) * time);
          return new THREE.Vector3(size, size, size);
        },
      }),
      new ColorOverLifetime({
        color: new THREE.Color('#ffffff'),
        alpha: (time) => ((time) < 0.2 ? (time) / 0.2 : (time) < 0.75 ? 1 - 0.15 * (((time) - 0.2) / 0.55) : 0.85 * (1 - (((time) - 0.75) / 0.25))),
      }),
      new RotationOverLifetime({
        angularVelocity: [new THREE.Vector3(-0.5, 0, 0), new THREE.Vector3(0.5, 0, 0)],
      }),
    ],
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
          color: new THREE.Color('#ffb570'),
          intensity: 1,
          distance: 8,
          decay: 2,
        },
      }),
    ],
  });

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
    inheritVelocity: 0.35,
    ratio: 0.5,
  });

  fire.name = 'Fire';
  fire.position.set(0, 0, 0);

  return fire;
}

createFire.author = "rzmay";
createFire.description = "Sprite-sheet animation, soft particles, particle lights, and a heat-distortion subsystem.";

function createHeatDistortion(alphaMap, distortionMap, options) {
  return new ParticleSystem({
    duration: 1,
    looping: true,
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.05, 8, 6),
        rate: options.rate,
        radialSpeed: 1,
        initialValues: {
          lifetime: options.lifetime,
          scale: new THREE.Vector3(options.scale, options.scale, options.scale),
          velocity: new THREE.Vector3(0, options.velocity, 0),
          color: new THREE.Color('#ffffff'),
          rotation: [
            new THREE.Vector3(-Math.PI, 0, 0),
            new THREE.Vector3(Math.PI, 0, 0),
          ],
        },
      }),
    ],
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
          return new THREE.Vector3(size, size, size);
        },
      }),
      // new ColorOverLifetime({
      //   alpha: (time) => Easing.cubic.in(THREE.MathUtils.clamp(time * 5, 0, 1)) * (1 - Easing.cubic.in(THREE.MathUtils.clamp((time - 0.8) * 5, 0, 1))),
      // }),
      new RotationOverLifetime({
        angularVelocity: [
          new THREE.Vector3(-0.45, 0, 0),
          new THREE.Vector3(0.45, 0, 0),
        ],
      }),
    ],
    renderers: [
      new SpriteRenderer(Textures.Default, {
        alphaMap,
        softParticleDistance: 2.5,
        materialOptions: {
          opacity: 0.35,
          transmission: 1,
          distortionMap,
          distortionStrength: 8,
          depthWrite: false,
        },
      }),
    ],
  });
}
