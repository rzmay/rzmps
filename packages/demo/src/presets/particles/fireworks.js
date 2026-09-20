import * as THREE from 'three';
import {
  Audio as AudioModule,
  ColorOverLifetime,
  Emitter,
  EmissionShape,
  LightRenderer,
  ParticleSystem,
  ScaleOverLifetime,
  SpriteRenderer,
  TrailRenderer,
  TrailTextureMode,
  MeshRenderer,
  TransformByNoise,
  LimitVelocityOverLifetime,
  RotationOverLifetime,
  Textures,
} from '@rzmps/rzmps';

import fireworkSprite from 'url:../../assets/images/firework.png';
import smokeAlpha from 'url:../../assets/images/smoke_alpha.jpg';
import sparklesSprite from 'url:../../assets/images/sparkle_tile_5x2_n10.png';
import launchSound1Url from 'url:../../assets/audio/firework_launch_1.mp3';
import launchSound2Url from 'url:../../assets/audio/firework_launch_2.mp3';
import blastSound1Url from 'url:../../assets/audio/firework_blast_1.mp3';
import blastSound2Url from 'url:../../assets/audio/firework_blast_2.mp3';
import { curvePresets } from '../curvePresets';


export default async function createFireworks() {
  const audioLoader = new THREE.AudioLoader();
  const [launchSound1, launchSound2, blastSound1, blastSound2] = await Promise.all([
    audioLoader.loadAsync(launchSound1Url),
    audioLoader.loadAsync(launchSound2Url),
    audioLoader.loadAsync(blastSound1Url),
    audioLoader.loadAsync(blastSound2Url),
  ]);

  const fireworks = new ParticleSystem({
    duration: 2.6,
    looping: true,
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(1),
        rate: 3,
        initialValues: {
          lifetime: 2,
          velocity: new THREE.Vector3(0, 8.5, 0),
          scale: new THREE.Vector3(0.5, 0.5, 0.5),
          color: new Set([
            new THREE.Color('#ff4d6d'),
            new THREE.Color('#ffe14b'),
            new THREE.Color('#3eff3b'),
            new THREE.Color('#f786ff'),
            new THREE.Color('#11dfff'),
          ]),
        },
      }),
    ],
    modules: [
      new AudioModule({
        sound: [launchSound1, launchSound2],
        onDeathSound: [blastSound1, blastSound2],
        pitch: [0.8, 1.2],
        loop: false,
      }),
    ],
    renderers: [
      new SpriteRenderer(fireworkSprite, {
        material: 'basic',
      }),
    ],
  });

  const smoke = new ParticleSystem({
    duration: 10,
    looping: true,
    gravityModifier: -0.015,
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.1),
        rate: 36,
        radialSpeed: 0.18,
        initialValues: {
          lifetime: 4.5,
          speed: 0.55,
          scale: new THREE.Vector3(0.75, 0.75, 0.75),
          color: [new THREE.Color('#4e4d4a'), new THREE.Color('#a7a097')],
          alpha: 0.1,
          velocity: new THREE.Vector3(0, 0.75, 0),
        },
      }),
    ],
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
          const size = curvePresets.grow.evaluate(time);
          return new THREE.Vector3(size, size, size);
        },
      }),
      new ColorOverLifetime({
        color: new THREE.Color('#ffffff'),
        alpha: (time) => curvePresets.fadeOut.evaluate(time),
      }),
      new RotationOverLifetime({
        angularVelocity: [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)],
      }),
    ],
    renderers: [
      new SpriteRenderer(Textures.Default, {
        material: 'basic',
        alphaMap: smokeAlpha,
        softParticleDistance: 1,
        materialOptions: {
          roughness: 1,
          normalLighting: 0.5,
          sphericalNormals: true,
        }
      }),
    ],
  });
  smoke.name = 'Rocket Smoke';

  const sparkles = new ParticleSystem({
    duration: 5,
    looping: false,
    gravityModifier: 0.18,
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.08),
        rate: 0,
        bursts: [{ time: 0, count: [100, 300] }],
        radialSpeed: [4.5, 12],
        initialValues: {
          lifetime: [0.75, 1.35],
          scale: [new THREE.Vector3(0.5, 0.5, 0.5), new THREE.Vector3(1, 1, 1)],
          color: new THREE.Color('#ffffff')
        },
      }),
    ],
    modules: [
      new ColorOverLifetime({
        color: new THREE.Color('#ffffff'),
        alpha: (time) => Math.max(0, 1 - time),
      }),
    ],
    renderers: [
      new SpriteRenderer(sparklesSprite, {
        material: 'unlit',
        gridSize: { x: 5, y: 2 },
        fps: 10,
        randomStartFrame: true,
      }),
      new TrailRenderer({
        lifetime: 0.1,
        minimumVertexDistance: 0.02,
        dieWithParticles: false,
        width: (t) => 0.05 * curvePresets.fadeOut.evaluate(t),
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
  });
  sparkles.name = 'Sparkles';

  fireworks.addSubSystem(smoke, {
    emitContinuous: true,
    inheritLifetime: false,
    inheritColor: false,
    inheritScale: false,
  });

  fireworks.addSubSystem(sparkles, {
    emitOnDeath: true,
    inheritLifetime: false,
    inheritColor: true,
    inheritScale: false,
  });

  fireworks.name = 'Fireworks';
  fireworks.position.set(0, 0.25, 0);

  return fireworks;
}
