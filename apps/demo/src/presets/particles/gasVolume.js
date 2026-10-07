import * as THREE from 'three';
import {
  Emitter,
  EmissionShape,
  ColorOverLifetime,
  ForceOverLifetime,
  GasSimulation,
  ParticleSystem,
  ScaleOverLifetime,
  TransformByNoise,
  VolumeRenderer,
} from '@rzmps/rzmps';

export default async function createGasVolume() {
  const gas = new GasSimulation({
    pressureIterations: 12,
    externalForce: new THREE.Vector3(0, 0.05, 0),
    densityDissipation: 0.985,
    temperatureDissipation: 0.98,
    colorDissipation: 0.985,
    velocityDissipation: 0.995,
    buoyancy: 0.18,
    weight: 0.015,
    sourceStrength: 0.9,
    velocitySourceStrength: 0.08,
    octreeOptions: {
      maxDepth: 5,
      particlesPerLeaf: 3,
      brickLevel: -3
    },
  });

  const system = new ParticleSystem({
    duration: 10,
    looping: true,
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.45, 18, 10),
        rate: 52,
        radialSpeed: 0.25,
        initialValues: {
          lifetime: 2.6,
          mass: 1,
          speed: 0.8,
          scale: new THREE.Vector3(0.75, 0.75, 0.75),
          color: [
            new THREE.Color('#ff9d57'),
            new THREE.Color('#8ec5ff'),
            new THREE.Color('#d8d2c5'),
          ],
          alpha: 0.9,
          velocity: new THREE.Vector3(0, 1.6, 0),
        },
      }),
    ],
    modules: [
      gas,
      new ForceOverLifetime({
        force: new THREE.Vector3(0, 0.35, 0),
      }),
      new TransformByNoise({
        strength: new THREE.Vector3(1.6, 0.25, 1.6),
        frequency: 0.9,
      }),
      new ScaleOverLifetime({
        scale: (time) => {
          const size = 0.25 + (1.1 - 0.25) * time;
          return new THREE.Vector3(size, size, size);
        },
      }),
      new ColorOverLifetime({
        color: (time) => new THREE.Color().lerpColors(
          new THREE.Color('#ffb56f'),
          new THREE.Color('#8ec5ff'),
          THREE.MathUtils.smoothstep(time, 0.25, 1),
        ),
        alpha: (time) => 1 - THREE.MathUtils.smoothstep(time, 0.65, 1),
      }),
    ],
    renderers: [
      new VolumeRenderer({
        opacity: 0.18,
        threshold: 0.055,
        range: 0.035,
        steps: 64,
      }),
    ],
  });

  system.name = 'Gas Volume';
  system.position.set(0, 0, 0);

  return system;
}

createGasVolume.author = "rzmay";
createGasVolume.description = "Eulerian gas density rendered as a colored volume from particle sources.";
