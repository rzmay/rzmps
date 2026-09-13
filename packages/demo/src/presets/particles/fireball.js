import * as THREE from 'three';
import {
  ColorOverLifetime,
  Emitter,
  EmissionShape,
  LightRenderer,
  ParticleSystem,
  ScaleOverLifetime,
  SpriteRenderer,
} from '@rzmps/rzmps';
import fireballSprite from 'url:../../assets/images/fireball_tile_5x4_n20.png';
import { curvePresets } from '../curvePresets';

export default async function createFireball() {
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
          lifetime: 0.7,
          speed: 1,
          scale: new THREE.Vector3(10, 10, 10),
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
          const size = curvePresets.grow.evaluate(time);
          return new THREE.Vector3(size, size, size);
        },
      }),
      new ColorOverLifetime({
        color: new THREE.Color('#fff2e8'),
        alpha: (time) => curvePresets.fadeOut.evaluate(time),
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

  fireball.name = 'Fireball';
  fireball.position.set(0, 2, 0);

  return fireball;
}
