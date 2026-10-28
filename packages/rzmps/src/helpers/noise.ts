import { makeNoise4D } from 'fast-simplex-noise';
import * as THREE from 'three';
import type { Node } from 'three/webgpu';
import {
  float,
  floor,
  fract,
  mix,
  mx_fractal_noise_float,
  vec3,
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

export function generateParticleNoise4D(
  position: THREE.Vector3,
  settings: NoiseSettings,
): number {
  return generateNoise(position, settings, true);
}

export function generateGPUParticleNoise(
  position: Node<'vec3'>,
  settings: NoiseSettings,
  time?: Node<'float'>,
): GPUParticleNoiseValues {
  const samplePosition = position.add(vec3(settings.offset).toVar()).mul(float(settings.frequency));
  const amplitudeSum = getAmplitudeSum(settings);
  const normalizeNoise = (noise: Node<'float'>) => noise
    .div(float(amplitudeSum))
    .mul(0.5)
    .add(0.5)
    .clamp(0, 1);

  return {
    noise: normalizeNoise(mx_fractal_noise_float(
      samplePosition,
      settings.octaves,
      settings.lacunarity,
      settings.persistence,
    )),
    noise4d: normalizeNoise(evolvingGPUNoise(samplePosition, settings, time ?? float(settings.time))),
  };
}

export function generateGPUParticleNoise4D(
  position: Node<'vec3'>,
  settings: NoiseSettings,
  time?: Node<'float'>,
): Node<'float'> {
  const samplePosition = position.add(vec3(settings.offset).toVar()).mul(float(settings.frequency));
  const amplitudeSum = getAmplitudeSum(settings);

  return evolvingGPUNoise(samplePosition, settings, time ?? float(settings.time))
    .div(float(amplitudeSum))
    .mul(0.5)
    .add(0.5)
    .clamp(0, 1);
}

function evolvingGPUNoise(position: Node<'vec3'>, settings: NoiseSettings, time: Node<'float'>): Node<'float'> {
  // MaterialX fractal noise is 3D: passing vec4 silently discards time. Blend
  // spatially decorrelated slices with a C2 temporal curve instead of scrolling.
  const slice = floor(time);
  const t = fract(time);
  const blend = t.mul(t).mul(t).mul(t.mul(t.mul(6).sub(15)).add(10));
  const offset = vec3(19.193, 73.719, 41.317);
  const sample = (index: Node<'float'>) => mx_fractal_noise_float(
    position.add(offset.mul(index)), settings.octaves, settings.lacunarity, settings.persistence,
  );
  return mix(sample(slice), sample(slice.add(1)), blend) as Node<'float'>;
}

function getAmplitudeSum(settings: NoiseSettings): number {
  let sum = 0;

  for (let index = 0; index < settings.octaves; index += 1) {
    sum += settings.persistence ** index;
  }

  return sum || 1;
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
