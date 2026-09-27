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
  Textures,
  TransformByNoise,
} from '@rzmps/rzmps';
import smokeAlpha from '../../assets/images/smoke_alpha.jpg?url';

export default async function createSmoke() {
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
          scale: new THREE.Vector3(2.5, 2.5, 2.5),
          color: [new THREE.Color('#4e4d4a'), new THREE.Color('#a7a097')],
          alpha: 0.55,
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
          const size = (0.35 + (1.8 - 0.35) * time);
          return new THREE.Vector3(size, size, size);
        },
      }),
      new ColorOverLifetime({
        color: new THREE.Color('#ffffff'),
        alpha: (time) => ((time) < 0.2 ? (time) / 0.2 : (time) < 0.75 ? 1 - 0.15 * (((time) - 0.2) / 0.55) : 0.85 * (1 - (((time) - 0.75) / 0.25))),
      }),
      new RotationOverLifetime({
        angularVelocity: [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)],
      }),
    ],
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
  });

  smoke.name = 'Smoke';
  smoke.position.set(0, 0, 0);

  return smoke;
}

createSmoke.author = "rzmay";
createSmoke.description = "Lit smoke sprites with soft particles and lifetime scale/color shaping.";
