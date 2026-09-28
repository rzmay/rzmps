import { makeNoise4D } from 'fast-simplex-noise';
import * as THREE from 'three';

export interface NoiseSettings {
  octaves: number;
  frequency: number;
  lacunarity: number;
  persistence: number;
  time: number;
  offset: THREE.Vector3;
}

export interface ParticleNoiseValues {
  noise: number;
  noise4d: number;
}

const noiseGenerator = makeNoise4D();

export function generateParticleNoise(
  position: THREE.Vector3,
  settings: NoiseSettings,
): ParticleNoiseValues {
  return {
    noise: generateNoise(position, settings, false),
    noise4d: generateNoise(position, settings, true),
  };
}

function generateNoise(position: THREE.Vector3, settings: NoiseSettings, w = false): number {
  const layers = [];
  for (let i = 0; i < settings.octaves; i += 1) {
    const frequency = settings.frequency * (settings.lacunarity ** i);
    const amplitude = settings.persistence ** i;

    const rawNoise = Math.min(Math.max((noiseGenerator(
      (position.x + settings.offset.x) * frequency,
      (position.y + settings.offset.y) * frequency,
      (position.z + settings.offset.z) * frequency,
      w ? settings.time : 0,
    ) + 1) / 2, 0), 1);

    layers.push({
      value: rawNoise * amplitude,
      weight: amplitude,
    });
  }

  return layers.map((layer) => layer.value).reduce((a, b) => a + b)
    / layers.map((layer) => layer.weight).reduce((a, b) => a + b);
}
