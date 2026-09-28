import { makeNoise4D } from 'fast-simplex-noise';
import * as THREE from 'three';
import type { Node } from 'three/webgpu';
import {
  float,
  mx_fractal_noise_float,
  vec3,
  vec4,
} from 'three/tsl';

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

export interface GPUParticleNoiseValues {
  noise: Node<'float'>;
  noise4d: Node<'float'>;
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

export function generateGPUParticleNoise(
  position: Node<'vec3'>,
  settings: NoiseSettings,
  time?: Node<'float'>,
): GPUParticleNoiseValues {
  const samplePosition = position.add(vec3(settings.offset).toVar()).mul(float(settings.frequency));
  const samplePosition4d = vec4(
    samplePosition.x,
    samplePosition.y,
    samplePosition.z,
    time ?? float(settings.time),
  );

  return {
    noise: mx_fractal_noise_float(
      samplePosition,
      settings.octaves,
      settings.lacunarity,
      settings.persistence,
    ).clamp(0, 1),
    noise4d: mx_fractal_noise_float(
      samplePosition4d,
      settings.octaves,
      settings.lacunarity,
      settings.persistence,
    ).clamp(0, 1),
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
