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

export default async function createParticleTrail() {
  const simpleSpriteTexture = new THREE.TextureLoader().load(Textures.Simple);

  // #region docs:system:1
  const particleTrail = new ParticleSystem({
    maxParticles: 64,
    duration: 2,
    looping: true,
    gravity: new THREE.Vector3(0, -1.5, 0),
    // #region docs:emitters:1
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
          scale: 0.15,
        },
      }),
    ],
    // #endregion docs:emitters:1
    // #region docs:modules:1
    modules: [
      new TransformByNoise({
        strength: new THREE.Vector3(100, 0, 100),
        frequency: 5,
      }),
    ],
    // #endregion docs:modules:1
    // #region docs:renderers:1
    renderers: [
      new TrailRenderer({
        mode: TrailMode.Particle,
        ratio: 1,
        lifetime: 0.75,
        minimumVertexDistance: 0.05,
        dieWithParticles: false,
        width: 0.18,
        widthOverTrail: (time) => {
          if (time < 0.2) return time / 0.2;
          if (time < 0.75) return 1 - 0.15 * ((time - 0.2) / 0.55);
          return 0.85 * (1 - ((time - 0.75) / 0.25));
        },
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
    // #endregion docs:renderers:1
  });
  // #endregion docs:system:1

  particleTrail.name = 'Particle Trail';
  particleTrail.position.set(0, 0, 0);

  return particleTrail;
}

createParticleTrail.author = "rzmay";

/** @type {import("./types").ExampleMetadata} */
export const metadata = {
  "id": "particleTrail",
  "title": "Particle Trail",
  "description": "Per-particle trail rendering with inherited color and alpha over moving particles.",
  "tags": [
    "particleTrail"
  ],
  "category": "effects"
};

createParticleTrail.description = metadata.description;
