import * as THREE from 'three';
import {
  Emitter,
  EmissionShape,
  ParticleSystem,
  TrailRenderer,
  TrailMode,
  TransformByNoise,
  TrailTextureMode,
  Textures,
} from '@rzmps/rzmps';
import { curvePresets } from '../curvePresets';

export default async function createParticleTrail() {
  const simpleSpriteTexture = new THREE.TextureLoader().load(Textures.Simple);

  const particleTrail = new ParticleSystem({
    duration: 2,
    looping: true,
    gravity: new THREE.Vector3(0, -1.5, 0),
    emitters: [
      new Emitter({
        source: new EmissionShape({
          geometry: new THREE.SphereGeometry(0.15, 12, 8),
        }),
        rate: 8,
        initialValues: {
          lifetime: 2.5,
          velocity: [
            new THREE.Vector3(-1.5, 4, -1.5),
            new THREE.Vector3(1.5, 6, 1.5),
          ],
          scale: new THREE.Vector3(0.15, 0.15, 0.15),
        },
      }),
    ],
    modules: [
      new TransformByNoise({
        strength: new THREE.Vector3(100, 0, 100),
        frequency: 5,
      }),
    ],
    renderers: [
      new TrailRenderer({
        mode: TrailMode.Particle,
        ratio: 1,
        lifetime: 0.75,
        minimumVertexDistance: 0.05,
        dieWithParticles: false,
        width: 0.18,
        widthOverTrail: (time) => curvePresets.fadeInOut.evaluate(time),
        colorOverTrail: (time) => new THREE.Color().lerpColors(
          new THREE.Color('#00d0ff'),
          new THREE.Color('#ff66ba'),
          time,
        ),
        inheritParticleColor: true,
        textureMode: TrailTextureMode.Stretch,
        materialOptions: {
          roughness: 0.7,
          map: simpleSpriteTexture,
        },
      }),
    ],
  });

  particleTrail.name = 'Particle Trail';
  particleTrail.position.set(0, 1, 0);

  return particleTrail;
}
