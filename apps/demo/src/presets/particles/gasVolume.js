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
    pressureIterations: 16,
    externalForce: new THREE.Vector3(0, 0.05, 0),
    densityDissipation: 0.9,
    temperatureDissipation: 1.2,
    colorDissipation: 0.9,
    velocityDissipation: 0.3,
    buoyancy: 0.55,
    weight: 0.03,
    sourceStrength: 10,
    velocitySourceStrength: 2.2,
    sourceTemperature: 1,
    temperatureOverLifetime: (time) => 1 - time,
    scalarDiffusion: 0.35,
    temperatureColor: [
      new THREE.Color('#72a9d6'),
      new THREE.Color('#ff9a4d'),
    ],
    temperatureRange: [0, 1],
    vorticityStrength: 0.75,
    noiseFrequency: 1.4,
    noiseSpeed: 0.45,
    noiseOctaves: 2,
    spatialGridOptions: {
      brickSubdivisions: 2,
      cellSubdivisions: 4,
      powerOfTwoBounds: true,
      autoExpand: true,
      shrinkDelay: 180,
    },
  });

  const system = new ParticleSystem({
    duration: 10,
    looping: true,
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.45, 18, 10),
        rate: 55,
        radialSpeed: 0.75,
        initialValues: {
          lifetime: 1.2,
          mass: 1,
          speed: 0.8,
          scale: new THREE.Vector3(0.32, 0.32, 0.32),
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
          const size = 0.38 + (0.08 - 0.38) * time;
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
        opacity: 0.16,
        threshold: 0.025,
        range: 0.02,
        steps: 80,
      }),
    ],
  });

  system.name = 'Gas Volume';
  system.position.set(0, 0, 0);

  return system;
}

createGasVolume.author = "rzmay";
createGasVolume.description = "Eulerian gas density rendered as a colored volume from particle sources.";
