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
} from 'rzmps';
import fireSprite from 'url:../../assets/images/fire_tile_8x4_n32.png';
import { curvePresets } from '../curvePresets';

export default async function createFire() {
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
          scale: new THREE.Vector3(10, 10, 10),
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
          const size = curvePresets.shrink.evaluate(time);
          return new THREE.Vector3(size, size, size);
        },
      }),
      new ColorOverLifetime({
        color: new THREE.Color('#ffffff'),
        alpha: (time) => curvePresets.fadeInOut.evaluate(time),
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

  fire.name = 'Fire';
  fire.position.set(0, 1, 0);

  return fire;
}
