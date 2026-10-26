import * as THREE from 'three';
import type { Node } from 'three/webgpu';
import Module, { type ModuleGPUUpdate, type ModuleOptions, type ModuleUpdate } from '../Module';
import Particle from '../Particle';
import type { GPUParticleLike } from '../gpu/Particle';
import {
  generateGPUParticleNoise,
  generateParticleNoise,
  type GPUParticleNoiseValues,
  type ParticleNoiseValues,
} from '../helpers/noise';

export interface NoiseOptions extends Partial<ModuleOptions> {
    /** Number of noise layers; additional layers increase sampling work. Defaults to 1. */
    octaves: number;
    /** Spatial frequency of the noise; larger values produce smaller features. Defaults to 1. */
    frequency: number;
    /** Frequency multiplier between successive noise octaves. Defaults to 2. */
    lacunarity: number;
    /** Amplitude multiplier between successive noise octaves. Defaults to 0.5. */
    persistence: number;
    /** Noise temporal coordinate; custom callbacks can advance it explicitly. */
    time: number;
    /** Spatial noise offset, independent of the particle position. */
    offset: THREE.Vector3;
}

export type NoiseModuleUpdate = (
  particle: Particle,
  deltaTime: number,
  noise: ParticleNoiseValues,
) => void;

export type NoiseModuleGPUUpdate = (
  particle: GPUParticleLike,
  deltaTime: Node<'float'>,
  noise: GPUParticleNoiseValues,
) => void;

/**
 * Computes particle-position simplex noise for a callback or named particle.noise entry; octave count adds sampling
 * cost.
 */
class NoiseModule extends Module {
    public octaves = 1;

    public frequency = 1;

    public lacunarity = 2.0;

    public persistence = 0.5;

    public time = 0;

    public offset = new THREE.Vector3();

    public key: string;
    private _gpuNoiseSignature = '';

    /** Creates the modifier with its built-in priority and optional filtering/LOD settings. */
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

    public generateNoiseGPU(particle: GPUParticleLike, time?: Node<'float'>): GPUParticleNoiseValues {
      return generateGPUParticleNoise(particle.position, this, time);
    }

    public override syncGPUConfiguration(): void {
      super.syncGPUConfiguration();
      const signature = [
        this.octaves,
        this.frequency,
        this.lacunarity,
        this.persistence,
        this.time,
        this.offset.x,
        this.offset.y,
        this.offset.z,
      ].join(':');
      if (this._gpuNoiseSignature && signature !== this._gpuNoiseSignature) this.needsUpdate = true;
      this._gpuNoiseSignature = signature;
    }
}

export default NoiseModule;
