import * as THREE from 'three';
import type { Node } from 'three/webgpu';
import Module, { type ModuleGPUUpdate, type ModuleOptions, type ModuleUpdate } from '../Module';
import Particle from '../Particle';
import type { GPUParticle } from '../GPUParticle';
import {
  generateGPUParticleNoise,
  generateParticleNoise,
  type GPUParticleNoiseValues,
  type ParticleNoiseValues,
} from '../helpers/noise';

export interface NoiseOptions extends Partial<ModuleOptions> {
    octaves: number;
    frequency: number;
    lacunarity: number;
    persistence: number;
    time: number;
    offset: THREE.Vector3;
}

export type NoiseModuleUpdate = (
  particle: Particle,
  deltaTime: number,
  noise: ParticleNoiseValues,
) => void;

export type NoiseModuleGPUUpdate = (
  particle: GPUParticle,
  deltaTime: number,
  noise: GPUParticleNoiseValues,
) => void;

class NoiseModule extends Module {
    public octaves = 1;

    public frequency = 1;

    public lacunarity = 2.0;

    public persistence = 0.5;

    public time = 0;

    public offset = new THREE.Vector3();

    public key: string;

    constructor(
      key: string,
      options?: Partial<NoiseOptions>,
    );
    constructor(
      update: NoiseModuleUpdate,
      options?: Partial<NoiseOptions> & { modifyGPU?: NoiseModuleGPUUpdate },
    );
    constructor(
      keyOrUpdate: string | NoiseModuleUpdate,
      options: Partial<NoiseOptions> & { modifyGPU?: NoiseModuleGPUUpdate } = {},
    ) {
      const key = typeof keyOrUpdate === 'string' ? keyOrUpdate : '';
      const update = typeof keyOrUpdate === 'function'
        ? keyOrUpdate
        : ((particle: Particle, _deltaTime: number, noise: ParticleNoiseValues) => {
          particle.noise[key] = noise;
        });

      const modify: ModuleUpdate = (particle, deltaTime) => {
        update(particle, deltaTime, this.generateNoise(particle));
      };

      const modifyGPU: ModuleGPUUpdate = options.modifyGPU
        ? (particle, deltaTime) => {
          options.modifyGPU?.(particle, deltaTime, this.generateNoiseGPU(particle));
        }
        : Module.GPU_UNSUPPORTED;

      super(modify, {
        ...options,
        modifyGPU,
      });

      this.key = key;
      this.octaves = options.octaves ?? this.octaves;
      this.frequency = options.frequency ?? this.frequency;
      this.lacunarity = options.lacunarity ?? this.lacunarity;
      this.persistence = options.persistence ?? this.persistence;
      this.time = options.time ?? this.time;
      this.offset = options.offset ?? this.offset;
    }

    public generateNoise(particle: Particle): ParticleNoiseValues {
      return generateParticleNoise(particle.position, this);
    }

    public generateNoiseGPU(particle: GPUParticle, time?: Node<'float'>): GPUParticleNoiseValues {
      return generateGPUParticleNoise(particle.position, this, time);
    }
}

export default NoiseModule;
