import * as THREE from 'three';
import {
  Audio,
  Collision,
  ColorOverLifetime,
  Emitter,
  EmissionShape,
  ParticleSystem,
  SpriteRenderer,
  TransformByNoise,
} from 'rzmps';

import circleSprite from 'url:../../assets/images/circle.png';

import bubblesUrl from 'url:../../assets/audio/bubbles.mp3';
import bubblePop1Url from 'url:../../assets/audio/bubble_pop_1.mp3';
import bubblePop2Url from 'url:../../assets/audio/bubble_pop_2.mp3';

import { curvePresets } from '../curvePresets';

export default async function createBubbles() {
  const audioLoader = new THREE.AudioLoader();

  const [
    bubbles,
    bubblePop1,
    bubblePop2,
  ] = await Promise.all([
    audioLoader.loadAsync(bubblesUrl),
    audioLoader.loadAsync(bubblePop1Url),
    audioLoader.loadAsync(bubblePop2Url),
  ]);

  const system = new ParticleSystem({
    duration: 10,
    looping: true,
    gravityModifier: 0.05,

    emitters: [
      new Emitter({
        source: new EmissionShape({
          geometry: new THREE.SphereGeometry(0.5, 16, 12),
        }),

        rate: 8,

        radialSpeed: [1, 3],

        initialValues: {
          lifetime: [7, 12],

          scale: [
            new THREE.Vector3(0.5, 0.5, 0.5),
            new THREE.Vector3(1, 1, 1),
          ],

          mass: 0.25,

          color: [
            new THREE.Color('#bdefff'),
            new THREE.Color('#d8c8ff'),
            new THREE.Color('#bfffe4'),
          ],

          alpha: 0.65,
        },
      }),
    ],

    modules: [
      new TransformByNoise({
        strength: new THREE.Vector3(0.2, 0.05, 0.2),
        frequency: 0.6,
      }),

      new Collision({
        bounce: 0.9,
        dampen: 0.03,
        radiusScale: 0.5,
        lifetimeLoss: 1,
      }),

      new ColorOverLifetime({
        alpha: (time) => 0.65 * curvePresets.fadeInOut.evaluate(time),
      }),

      new Audio({
        sound: bubbles,

        onCollisionSound: [
          bubblePop1,
          bubblePop2,
        ],

        // Only a few particles need looping positional audio.
        // Having every bubble play the same bubbling track would get loud.
        ratio: 0.15,

        // Every bubble pops
        collisionRatio: 1,

        pitch: 1,
        volume: 1,

        // Larger bubbles have a somewhat deeper sound.
        sizeAffectsPitch: 0.3,
        sizeAffectsVolume: 0.15,

        // Fade the looping sound with the particle.
        alphaAffectsPitch: 0,
        alphaAffectsVolume: 1,

        // Fast-moving bubbles become slightly more animated sounding.
        speedAffectsPitch: 0.08,
        speedAffectsVolume: 0.05,
      }),
    ],

    renderers: [
      new SpriteRenderer(circleSprite, {
        material: 'basic',

        materialOptions: {
          roughness: 0.15,
          sphericalNormals: true,
          normalLighting: 0.6,
        },
      }),
    ],
  });

  system.name = 'Audio Bubbles';
  system.position.set(0, 5, 0);

  return system;
}
