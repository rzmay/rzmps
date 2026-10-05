import * as THREE from 'three';
import {
  AudioRenderer,
  Collision,
  Emitter,
  EmissionShape,
  ParticleSystem,
  SpriteRenderer,
  Textures,
  TransformByNoise,
  ScaleOverLifetime,
  DistortionBySize,
} from '@rzmps/rzmps';

import simpleNorm from '../../assets/images/simple_norm.png?url';
import bubblesUrl from '../../assets/audio/bubbles.mp3?url';
import bubblePop1Url from '../../assets/audio/bubble_pop_1.mp3?url';
import bubblePop2Url from '../../assets/audio/bubble_pop_2.mp3?url';

import { Easing } from 'eaz';

const withAudioSource = (buffer, url) => {
  Object.defineProperty(buffer, '__rzmpsAudioBufferSource', {
    value: { url, name: url.split('/').pop() ?? url },
    configurable: true,
  });

  return buffer;
};

export default async function createBubbles() {
  const audioLoader = new THREE.AudioLoader();

  const simple = new THREE.TextureLoader().load(Textures.Simple);
  const distortionSimple = new THREE.TextureLoader().load(simpleNorm);


  const [
    bubbles,
    bubblePop1,
    bubblePop2,
  ] = await Promise.all([
    audioLoader.loadAsync(bubblesUrl),
    audioLoader.loadAsync(bubblePop1Url),
    audioLoader.loadAsync(bubblePop2Url),
  ]);

  withAudioSource(bubbles, bubblesUrl);
  withAudioSource(bubblePop1, bubblePop1Url);
  withAudioSource(bubblePop2, bubblePop2Url);

  const system = new ParticleSystem({
    duration: 10,
    looping: true,
    gravityModifier: 0.05,
    useLiveCubemap: true,

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
            new THREE.Vector3(0.25, 0.25, 0.25),
            new THREE.Vector3(1, 1, 1),
          ],

          mass: 0.25,

          color: [
            new THREE.Color('#bdefff'),
            new THREE.Color('#d8c8ff'),
            new THREE.Color('#bfffe4'),
          ],
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
        radiusScale: 1,
        lifetimeLoss: 1,
      }),

      new ScaleOverLifetime({
        scale: (time) => new THREE.Vector3(1, 1, 1).multiplyScalar(Easing.cubic.in(THREE.MathUtils.clamp(time * 5, 0, 1))),
      }),

      new DistortionBySize({
        sizeRange: [0, 1],
        distortionStrength: [0, 1]
      }),
    ],

    renderers: [
      new SpriteRenderer(Textures.Circle, {
        material: 'lit',

        materialOptions: {
          roughness: 0.15,
          metalness: 0.5,
          sphericalNormals: 1,
          normalLighting: 0.75,
          transmissionMap: simple,
          transmission: 0.7,
          distortionMap: distortionSimple,
          distortionStrength: -0.05,
        },
      }),
      new AudioRenderer({
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
  });

  system.name = 'Audio Bubbles';
  system.position.set(0, 0, 0);

  return system;
}

createBubbles.author = "rzmay";
createBubbles.description = "Refractive sprite transmission with spherical normals and size-driven distortion. Both continuous sounds and collision-triggered bubble pops.";
