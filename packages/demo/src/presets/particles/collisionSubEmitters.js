import * as THREE from 'three';
import {
  Audio,
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
import ballHitUrl from 'url:../../assets/audio/ball_hit.mp3';

export default async function createCollisionSubEmitters() {
  const ballHit = await new THREE.AudioLoader().loadAsync(ballHitUrl);

  const collision = new ParticleSystem({
    duration: 5,
    looping: true,
    gravityModifier: 1,
    useLiveCubemap: true,
    liveCubemapIntensity: 3,
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.25),
        rate: 30,
        radialSpeed: [1, 5],
        initialValues: {
          lifetime: 8,
          scale: new THREE.Vector3(0.125, 0.125, 0.125),
          mass: 1,
          color: new THREE.Color('#aaa'),
        },
      }),
    ],
    modules: [
      new Collision({
        bounce: 0.75,
        dampen: 0.05,
        radiusScale: 1,
        applyImpulses: true,
      }),
      new Audio({
        onCollisionSound: ballHit,
        collisionRatio: 1,
        pitch: [0.8, 1.2],
        volume: 0.18,
        impulseAffectsVolume: 0.5,
        impulseThreshhold: 0.1,
        lowPass: 1800,
        impulseAffectsLowPass: 1,
      }),
    ],
    renderers: [
      new SpriteRenderer(Textures.Circle, {
        material: 'basic',
        castShadow: true,
        materialOptions: {
          roughness: 0,
          metalness: 1,
          sphericalNormals: true,
          normalLighting: 1,
        },
      }),
    ],
  });

  const sparks = new ParticleSystem({
    duration: 0.08,
    looping: false,
    gravityModifier: 1,
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
          scale: [new THREE.Vector3(0.01, 0.01, 0.01), new THREE.Vector3(0.1, 0.1, 0.1)],
          color: [
            new THREE.Color('#fff4b0'),
            new THREE.Color('#ff8a3d'),
          ],
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
      new TrailRenderer({
        lifetime: 0.16,
        minimumVertexDistance: 0.015,
        dieWithParticles: false,
        width: 0.18,
        sizeAffectsWidth: true,
        inheritParticleColor: true,
        materialOptions: {
          emissive: new THREE.Color('#ffb347'),
          emissiveIntensity: 4,
          roughness: 1,
          transparent: true,
          depthWrite: false,
        },
      }),
    ],
  });
  sparks.name = 'Collision Sparks';

  collision.addSubSystem(sparks, {
    emitContinuous: false,
    emitOnCollision: true,
    inheritLifetime: false,
    impulseAffectsScale: 0.1,
    impulseAffectsSpeed: 0.45,
    impulseAffectsAlignment: true,
    impulseThreshhold: 1.2,
  });

  collision.name = 'Collision + Sub Emitters';
  collision.position.set(0, 5, 0);

  return collision;
}
