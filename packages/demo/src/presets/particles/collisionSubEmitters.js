import * as THREE from 'three';
import {
  Collision,
  ColorOverLifetime,
  Emitter,
  EmissionShape,
  ParticleSystem,
  SpriteRenderer,
  TrailRenderer,
} from '@rzmps/rzmps';
import circleSprite from 'url:../../assets/images/circle.png';

export default async function createCollisionSubEmitters() {
  const collision = new ParticleSystem({
    duration: 5,
    looping: true,
    gravityModifier: 1,
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.25),
        rate: 30,
        radialSpeed: [1, 5],
        initialValues: {
          lifetime: 8,
          scale: new THREE.Vector3(0.5, 0.5, 0.5),
          mass: 1,
          color: [
            new THREE.Color('#ff6633'),
            new THREE.Color('#ffd166'),
          ],
        },
      }),
    ],
    modules: [
      new Collision({
        bounce: 0.75,
        dampen: 0.05,
        radiusScale: 0.5,
        applyImpulses: true,
      }),
    ],
    renderers: [
      new SpriteRenderer(circleSprite, {
        material: 'basic',
        castShadow: true,
        materialOptions: {
          roughness: 0.5,
          sphericalNormals: true,
          normalLighting: 1,
        },
      }),
    ],
  });

  const sparks = new ParticleSystem({
    duration: 0.08,
    looping: false,
    gravityModifier: 0.35,
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.03),
        rate: 0,
        bursts: [{ time: 0, count: 7 }],
        radialSpeed: [3.5, 7.5],
        initialValues: {
          lifetime: [0.18, 0.42],
          scale: new THREE.Vector3(1, 1, 1),
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
        width: 0.025,
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
  });

  collision.name = 'Collision + Sub Emitters';
  collision.position.set(0, 5, 0);

  return collision;
}
