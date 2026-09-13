import * as THREE from 'three';
import {
  Emitter,
  EmissionShape,
  LimitVelocityOverLifetime,
  ParticleSystem,
  RotationOverLifetime,
  SpriteRenderer,
  TransformByNoise,
  ColorOverLifetime,
} from 'rzmps';
import defaultSprite from 'url:../../assets/images/default.png';
import snowflakeAlpha from 'url:../../assets/images/snowflake_alpha.png';
import { curvePresets } from '../curvePresets';

export default async function createSnow() {
  const snow = new ParticleSystem({
    duration: 10,
    looping: true,
    gravityModifier: 0.025,
    emitters: [
      new Emitter({
        source: new EmissionShape({
          geometry: new THREE.BoxGeometry(14, 0.1, 14),
        }),
        rate: 70,
        radialSpeed: 0,
        initialValues: {
          lifetime: 8.5,
          speed: 1,
          scale: new THREE.Vector3(1, 1, 1),
          color: new THREE.Color('#e9f7ff'),
          alpha: 0.9,
          velocity: new THREE.Vector3(0, -0.35, 0),
        },
      }),
    ],
    modules: [
      new TransformByNoise({
        strength: new THREE.Vector3(0.28, 0.02, 0.28),
        frequency: 0.55,
      }),
      new LimitVelocityOverLifetime({
        limit: new THREE.Vector3(0.7, 0.65, 0.7),
        drag: 0.12,
        multiplyDragByVelocity: true,
      }),
      new RotationOverLifetime({
        angularVelocity: new THREE.Vector3(0.65, 0, 0),
      }),
      new ColorOverLifetime({
        alpha: (t) => curvePresets.fadeInOut.evaluate(t)
      })
    ],
    renderers: [
      new SpriteRenderer(defaultSprite, {
        material: 'basic',
        alphaMap: snowflakeAlpha,
        materialOptions: {
          normalLighting: 0.25,
          sphericalNormals: true
        }
      }),
    ],
  });

  snow.name = 'Snow';
  snow.position.set(0, 6, 0);

  return snow;
}
