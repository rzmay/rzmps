import * as THREE from 'three';
import {
  ColorOverLifetime,
  Emitter,
  EmissionShape,
  LimitVelocityOverLifetime,
  ParticleSystem,
  RotationOverLifetime,
  ScaleOverLifetime,
  SpriteRenderer,
  TransformByNoise,
} from '@rzmps/rzmps';
import defaultSprite from 'url:../../assets/images/default.png';
import smokeAlpha from 'url:../../assets/images/smoke_alpha.jpg';
import { curvePresets } from '../curvePresets';

export default async function createAdditiveSmoke() {
  const smoke = new ParticleSystem({
    duration: 10,
    looping: true,
    gravityModifier: -0.015,
    emitters: [
      new Emitter({
        source: new EmissionShape({
          geometry: new THREE.ConeGeometry(0.75, 1.2, 24),
        }),
        rate: 36,
        radialSpeed: 0.18,
        initialValues: {
          lifetime: 4.5,
          speed: 0.55,
          scale: new THREE.Vector3(10, 10, 10),
          color: [new THREE.Color('#343230'), new THREE.Color('#79746e')],
          alpha: 0.35,
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
        alpha: (time) => curvePresets.fadeInOut.evaluate(time),
      }),
      new RotationOverLifetime({
        angularVelocity: [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)],
      }),
    ],
    renderers: [
      new SpriteRenderer(defaultSprite, {
        material: 'basic',
        alphaMap: smokeAlpha,
        softParticleDistance: 1,
        materialOptions: {
          roughness: 1,
          normalLighting: 0.5,
          sphericalNormals: true,
          blending: THREE.AdditiveBlending,
        }
      }),
    ],
  });

  smoke.name = 'Smoke';
  smoke.position.set(0, 1, 0);

  return smoke;
}
