import * as THREE from 'three';
import {
  ColorOverLifetime,
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
import fireballSprite from '../../assets/images/fireball_tile_5x4_n20.png?url';
import warpNormal from '../../assets/images/warp_norm.jpg?url';
import { Easing } from 'eaz';

export default async function createFireball() {
  const textureLoader = new THREE.TextureLoader();
  const heatDistortion = textureLoader.load(warpNormal);

  const fireball = new ParticleSystem({
    duration: 1.25,
    looping: true,
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
          scale: new THREE.Vector3(2.5, 2.5, 2.5),
          color: [new THREE.Color('#ffffff'), new THREE.Color('#ffd166')],
          rotation: [new THREE.Vector3(-90, 0, 0), new THREE.Vector3(90, 0, 0)],
          alpha: 1,
          velocity: new THREE.Vector3(0, 0, 0),
          radial: 0.45,
        },
      }),
    ],
    modules: [
      new ScaleOverLifetime({
        scale: (time) => {
          const size = (0.35 + (1.8 - 0.35) * time);
          return new THREE.Vector3(size, size, size);
        },
      }),
      new ColorOverLifetime({
        color: new THREE.Color('#fff2e8'),
        alpha: (time) => (1 - Easing.cubic.in(THREE.MathUtils.clamp(time, 0, 1))),
      }),
    ],
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
          color: new THREE.Color('#ffae97'),
          intensity: 1,
          distance: 8,
          decay: 2,
        },
      }),
    ],
  });

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

  fireball.name = 'Fireball';
  fireball.position.set(0, 0, 0);

  return fireball;
}

createFireball.author = "rzmay";
createFireball.description = "Showcases burst emission, animated sprite growth, particle lights, and inherited heat-distortion particles.";

function createHeatDistortion(alphaMap, distortionMap) {
  return new ParticleSystem({
    duration: 1,
    looping: true,
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.05, 8, 6),
        bursts: [{ time: 0, count: 5 }],
        radialSpeed: 2,
        initialValues: {
          lifetime: 0.5,
          scale: new THREE.Vector3(6, 6, 6),
          velocity: new THREE.Vector3(0, 1.35, 0),
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
      new ForceOverLifetime({
        force: new THREE.Vector3(0, 0.5, 0),
      }),
      new TransformByNoise({
        strength: new THREE.Vector3(0.55, 0.3, 0.55),
        frequency: 1.6,
      }),
      new ScaleOverLifetime({
        scale: (time) => new THREE.Vector3(2, 2, 2).multiplyScalar(Easing.cubic.out(time)),
      }),
      new ColorOverLifetime({
        alpha: (time) => ((time) < 0.2 ? (time) / 0.2 : (time) < 0.75 ? 1 - 0.15 * (((time) - 0.2) / 0.55) : 0.85 * (1 - (((time) - 0.75) / 0.25))),
      }),
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
          opacity: 0.3,
          transmission: 1,
          distortionMap,
          distortionStrength: 0.05,
          depthWrite: false,
        },
      }),
    ],
  });
}
