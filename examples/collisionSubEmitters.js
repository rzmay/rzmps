import * as THREE from 'three';
import {
  AudioRenderer,
  Collision,
  ColorOverLifetime,
  Emitter,
  EmissionShape,
  EmissionSource,
  ParticleSystem,
  SpriteRenderer,
  Textures,
  TrailRenderer,
} from '@rzmps/rzmps';
import ballHitUrl from '../apps/demo/src/assets/audio/ball_hit.mp3?url';

const withAudioSource = (buffer, url) => {
  Object.defineProperty(buffer, '__rzmpsAudioBufferSource', {
    value: { url, name: url.split('/').pop() ?? url },
    configurable: true,
  });

  return buffer;
};

export default async function createCollisionSubEmitters() {
  const ballHit = await new THREE.AudioLoader().loadAsync(ballHitUrl);
  withAudioSource(ballHit, ballHitUrl);

  // #region docs:system:1
  const collision = new ParticleSystem({
    duration: 5,
    looping: true,
    gravityModifier: 1,
    useLiveCubemap: true,
    liveCubemapIntensity: 3,
    // #region docs:emitters:1
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.25),
        rate: 5,
        radialSpeed: [1, 5],
        initialValues: {
          lifetime: 8,
          scale: 0.125,
          mass: 1,
          color: '#aaa',
        },
      }),
    ],
    // #endregion docs:emitters:1
    // #region docs:modules:1
    modules: [
      new Collision({
        bounce: 0.75,
        dampen: 0.05,
        radiusScale: 1,
      }),
    ],
    // #endregion docs:modules:1
    // #region docs:renderers:1
    renderers: [
      new SpriteRenderer(Textures.Circle, {
        material: 'lit',
        materialOptions: {
          roughness: 0.2,
          metalness: 0.6,
          sphericalNormals: 1,
          normalLighting: 1,
        },
      }),
      new AudioRenderer({
        onCollisionSound: ballHit,
        collisionRatio: 1,
        pitch: [0.8, 1.2],
        volume: 0.18,
        impulseAffectsVolume: 0.5,
        impulseThreshold: 0.5,
        lowPass: 1800,
        impulseAffectsLowPass: 1,
      }),
    ],
    // #endregion docs:renderers:1
  });
  // #endregion docs:system:1

  // #region docs:system:2
  const sparks = new ParticleSystem({
    maxParticles: 128,
    duration: 0.08,
    looping: false,
    gravityModifier: 1,
    // #region docs:emitters:2
    emitters: [
      new Emitter({
        source: new EmissionShape({
          geometry: new THREE.ConeGeometry(0.01, 0.01, 32, 1, true),
          source: EmissionSource.Volume,
        }),
        rate: 0,
        bursts: [{ time: 0, count: [3, 6] }],
        radialSpeed: [0.5, 2],
        initialValues: {
          lifetime: [0.18, 0.42],
          scale: [0.05, 0.15],
          color: [
            '#fff4b0',
            '#ff8a3d',
          ],
        },
      }),
    ],
    // #endregion docs:emitters:2
    // #region docs:modules:2
    modules: [
      new ColorOverLifetime({
        alpha: (time) => Math.max(0, 1 - time),
      }),
    ],
    // #endregion docs:modules:2
    // #region docs:renderers:2
    renderers: [
      new TrailRenderer({
        texture: Textures.Circle,
        lifetime: 0.16,
        minimumVertexDistance: 0.015,
        dieWithParticles: false,
        width: 0.18,
        sizeAffectsWidth: true,
        inheritParticleColor: true,
        materialOptions: {
          emissive: new THREE.Color('#ffb347'),
          emissiveIntensity: 2,
          roughness: 1,
          transparent: true,
          depthWrite: false,
        },
      }),
    ],
    // #endregion docs:renderers:2
  });
  // #endregion docs:system:2
  sparks.name = 'Metal Ball Sparks';

  collision.addSubSystem(sparks, {
    emitContinuous: false,
    emitOnCollision: true,
    inheritLifetime: 0,
    impulseAffectsScale: 0.1,
    impulseAffectsSpeed: 0.45,
    impulseAffectsAlignment: true,
    impulseThreshold: 1.2,
  });

  collision.name = 'Metal Balls';
  collision.position.set(0, 0, 0);

  return collision;
}

createCollisionSubEmitters.author = "rzmay";

/** @type {import("./types").ExampleMetadata} */
export const metadata = {
  "id": "collisionSubEmitters",
  "title": "Metal Balls",
  // eslint-disable-next-line max-len -- Documentation discovery requires a single literal description.
  "description": "Collision-triggered subsystems and sound effects with physics-driven EQ filtering and live-cubemap rendering for convincing metallic surfaces.",
  "tags": [
    "collisionSubEmitters"
  ],
  "category": "effects"
};

createCollisionSubEmitters.description = metadata.description;
