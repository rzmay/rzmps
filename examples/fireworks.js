import * as THREE from 'three';
import {
  AudioRenderer,
  ColorOverLifetime,
  Emitter,
  CompensationMode,
  EmissionShape,
  LightRenderer,
  ParticleSystem,
  ScaleOverLifetime,
  SpriteRenderer,
  TrailRenderer,
  TrailTextureMode,
  TransformByNoise,
  LimitVelocityOverLifetime,
  RotationOverLifetime,
  Textures,
} from '@rzmps/rzmps';

import fireworkSprite from '../apps/demo/src/assets/images/firework.png?url';
import smokeAlpha from '../apps/demo/src/assets/images/smoke_alpha.jpg?url';
import sparklesSprite from '../apps/demo/src/assets/images/sparkle_tile_5x2_n10.png?url';
import launchSound1Url from '../apps/demo/src/assets/audio/firework_launch_1.mp3?url';
import launchSound2Url from '../apps/demo/src/assets/audio/firework_launch_2.mp3?url';
import blastSound1Url from '../apps/demo/src/assets/audio/firework_blast_1.mp3?url';
import blastSound2Url from '../apps/demo/src/assets/audio/firework_blast_2.mp3?url';
import { Easing } from 'eaz';

const withAudioSource = (buffer, url) => {
  Object.defineProperty(buffer, '__rzmpsAudioBufferSource', {
    value: { url, name: url.split('/').pop() ?? url },
    configurable: true,
  });

  return buffer;
};

export default async function createFireworks() {
  const audioLoader = new THREE.AudioLoader();
  const [launchSound1, launchSound2, blastSound1, blastSound2] = await Promise.all([
    audioLoader.loadAsync(launchSound1Url),
    audioLoader.loadAsync(launchSound2Url),
    audioLoader.loadAsync(blastSound1Url),
    audioLoader.loadAsync(blastSound2Url),
  ]);

  withAudioSource(launchSound1, launchSound1Url);
  withAudioSource(launchSound2, launchSound2Url);
  withAudioSource(blastSound1, blastSound1Url);
  withAudioSource(blastSound2, blastSound2Url);

  // #region docs:system:1
  const fireworks = new ParticleSystem({
    maxParticles: 32,
    duration: 2.6,
    looping: true,
    // #region docs:emitters:1
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(1),
        rate: 3,
        initialValues: {
          lifetime: 2,
          velocity: new THREE.Vector3(0, 8.5, 0),
          scale: 0.5,
          color: new Set([
            '#ff4d6d',
            '#ffe14b',
            '#3eff3b',
            '#f786ff',
            '#11dfff',
          ]),
        },
      }),
    ],
    // #endregion docs:emitters:1
    // #region docs:modules:1
    modules: [],
    // #endregion docs:modules:1
    // #region docs:renderers:1
    renderers: [
      new AudioRenderer({
        sound: [launchSound1, launchSound2],
        onDeathSound: [blastSound1, blastSound2],
        pitch: [0.8, 1.2],
        loop: false,
      }),
      new SpriteRenderer(fireworkSprite, {
        material: 'lit',
        materialOptions: {
          normalLighting: 1.0,
          sphericalNormals: 1.0,
        }
      }),
    ],
    // #endregion docs:renderers:1
  });
  // #endregion docs:system:1

  // #region docs:system:2
  const smoke = new ParticleSystem({
    maxParticles: 2048,
    duration: 10,
    looping: true,
    gravityModifier: -0.015,
    // #region docs:emitters:2
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.1),
        rate: 36,
        radialSpeed: 0.18,
        initialValues: {
          lifetime: 4.5,
          speed: 0.55,
          scale: 0.75,
          color: ['#4e4d4a', '#a7a097'],
          alpha: 0.1,
          velocity: new THREE.Vector3(0, 0.75, 0),
        },
      }),
    ],
    // #endregion docs:emitters:2
    // #region docs:modules:2
    modules: [
      new TransformByNoise({
        strength: new THREE.Vector3(0.65, 0.35, 0.65),
        frequency: 0.8,
      }),
      new LimitVelocityOverLifetime({
        limit: new THREE.Vector3(1.1, 1.35, 1.1),
        drag: 0.1,
        multiplyDragByVelocity: true,
      }),
      new ScaleOverLifetime({
        scale: (time) => {
          const size = (0.35 + (1.8 - 0.35) * time);
          return size;
        },
      }),
      new ColorOverLifetime({
        color: '#ffffff',
        alpha: (time) => (1 - Easing.cubic.in(THREE.MathUtils.clamp(time, 0, 1))),
      }),
      new RotationOverLifetime({
        angularVelocity: [-1, 1],
      }),
    ],
    // #endregion docs:modules:2
    // #region docs:renderers:2
    renderers: [
      new SpriteRenderer(Textures.Default, {
        material: 'lit',
        alphaMap: smokeAlpha,
        softParticleDistance: 1,
        materialOptions: {
          roughness: 1,
          normalLighting: 0.5,
          sphericalNormals: 1,
        }
      }),
    ],
    // #endregion docs:renderers:2
  });
  // #endregion docs:system:2
  smoke.name = 'Rocket Smoke';

  // #region docs:system:3
  const sparkles = new ParticleSystem({
    maxParticles: 512,
    lod: { distance: 30, quality: 0.5, maxLevel: 2, continuous: true },
    duration: 5,
    looping: false,
    gravityModifier: 0.18,
    // #region docs:emitters:3
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.08),
        rate: 0,
        bursts: [{ time: 0, count: [50, 150] }],
        radialSpeed: [4.5, 12],
        initialValues: {
          lifetime: [0.75, 1.35],
          scale: [0.5, 1],
          color: '#ffffff'
        },
      }),
    ],
    // #endregion docs:emitters:3
    // #region docs:modules:3
    modules: [
      new ColorOverLifetime({
        color: '#ffffff',
        alpha: (time) => Math.max(0, 1 - time),
      }),
    ],
    // #endregion docs:modules:3
    // #region docs:renderers:3
    renderers: [
      new SpriteRenderer(sparklesSprite, {
        children: { count: 1, radius: 0.12, scale: 0.65, alpha: 0.7 },
        compensation: CompensationMode.Children,
        material: 'unlit',
        gridSize: { x: 5, y: 2 },
        fps: 10,
        randomStartFrame: true,
      }),
      new TrailRenderer({
        children: { count: 1, radius: 0.12, scale: 0.65, alpha: 0.7 },
        lifetime: 0.1,
        minimumVertexDistance: 0.02,
        dieWithParticles: false,
        width: (t) => 0.05 * (1 - Easing.cubic.in(THREE.MathUtils.clamp(t, 0, 1))),
        inheritParticleColor: true,
        alpha: 0.5,
        textureMode: TrailTextureMode.Stretch,
        materialOptions: {
          roughness: 1,
          transparent: true,
          map: new THREE.TextureLoader().load(Textures.Simple),
        },
      }),
      new LightRenderer({
        count: 10,
        ratio: 0.5,
        inheritParticleColor: true,
        sizeAffectsRange: false,
        alphaAffectsIntensity: true,
        brightness: 50,
        rangeMultiplier: 5,
        lightOptions: {
          intensity: 1,
          distance: 8,
          decay: 2,
        },
      }),
    ],
    // #endregion docs:renderers:3
  });
  // #endregion docs:system:3
  sparkles.name = 'Sparkles';

  fireworks.addSubSystem(smoke, {
    emitContinuous: true,
    inheritLifetime: 0,
    inheritColor: 0,
    inheritScale: 0,
  });

  fireworks.addSubSystem(sparkles, {
    emitOnDeath: true,
    inheritLifetime: 0,
    inheritColor: 1,
    inheritScale: 0,
  });

  fireworks.name = 'Fireworks';
  fireworks.position.set(0, 0, 0);

  return fireworks;
}

createFireworks.author = "rzmay";

/** @type {import("./types").ExampleMetadata} */
export const metadata = {
  "id": "fireworks",
  "title": "Fireworks",
  "description": "Chained subsystems, event bursts, audio cues, particle lights, and colorful sprite-sheet fireworks.",
  "tags": [
    "fireworks"
  ],
  "category": "effects"
};

createFireworks.description = metadata.description;
