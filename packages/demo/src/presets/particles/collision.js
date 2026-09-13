import * as THREE from 'three';
import {
  Collision,
  Emitter,
  EmissionShape,
  ParticleSystem,
  SpriteRenderer,
} from 'rzmps';
import circleSprite from 'url:../../assets/images/circle.png';

export default async function createCollision() {
  const collision = new ParticleSystem({
    duration: 5,
    looping: true,
    gravityModifier: 1,
    emitters: [
      new Emitter({
        source: new EmissionShape({
          geometry: new THREE.SphereGeometry(0.25, 16, 12),
        }),
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

  collision.name = 'Collision';
  collision.position.set(0, 5, 0);

  return collision;
}
