import * as THREE from 'three';
import {
  ColorByDepth,
  Emitter,
  EmissionShape,
  ParticleSystem,
  RotationByDepth,
  ScaleByDepth,
  SpeedByDepth,
  SpriteRenderer,
  Textures,
  VelocityByDepth,
} from '@rzmps/rzmps';

const depthRange = [5, 24];

export default async function createStylizedDepth() {
  // #region docs:system:1
  const system = new ParticleSystem({
    maxParticles: 2048,
    duration: 14,
    prewarm: true,
    prewarmFPS: 30,
    looping: true,
    gravity: new THREE.Vector3(0, 0, 0),
    gravityModifier: 0,

    // #region docs:emitters:1
    emitters: [
      new Emitter({
        source: new EmissionShape({
          geometry: new THREE.BoxGeometry(20, 10, 20),
        }),
        rate: 200,
        radialSpeed: 0,
        initialValues: {
          lifetime: [7, 12],
          speed: 1,
          velocity: new THREE.Vector3(0.01, 0.02, 0.3),
          scale: 0.02,
        },
      }),
    ],
    // #endregion docs:emitters:1

    // #region docs:modules:1
    modules: [
      new ColorByDepth({
        color: ['#fff7db', '#84d7ff'],
        alpha: [1, 0.5],
        depthRange,
      }),
      new ScaleByDepth({
        scale: [1, 2],
        depthRange,
      }),
      new RotationByDepth({
        angularVelocity: (t) => THREE.MathUtils.lerp(0.12, 1.6, THREE.MathUtils.smoothstep(t, 0.15, 1)),
        depthRange,
      }),
      new VelocityByDepth({
        velocity: (t) => new THREE.Vector3(
          Math.sin(t * Math.PI * 2) * 0.08,
          THREE.MathUtils.lerp(-1, 1, t),
          THREE.MathUtils.lerp(0, 1, t),
        ),
        depthRange,
      }),
      new SpeedByDepth({
        speed: (t) => THREE.MathUtils.lerp(0.5, 3, THREE.MathUtils.smoothstep(t, 0, 1)),
        depthRange,
      }),
    ],
    // #endregion docs:modules:1

    // #region docs:renderers:1
    renderers: [
      new SpriteRenderer(Textures.Circle, {
        material: 'unlit',
        sizeAttenuation: false,
      }),
    ],
    // #endregion docs:renderers:1
  });
  // #endregion docs:system:1

  system.name = 'Stylized Depth';
  system.position.set(0, 0, -6);

  return system;
}

createStylizedDepth.author = "rzmay";

/** @type {import("./types").ExampleMetadata} */
export const metadata = {
  "id": "stylizedDepth",
  "title": "Stylized Depth",
  "description": "Depth-based color, scale, speed, rotation, and velocity modules for stylized perspective effects.",
  "tags": [
    "stylizedDepth"
  ],
  "category": "effects"
};

createStylizedDepth.description = metadata.description;
