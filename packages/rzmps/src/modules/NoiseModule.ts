import * as THREE from 'three';
import Module, { type ModuleOptions, type ModuleUpdate } from '../Module';
import Particle from '../Particle';
import {
  generateParticleNoise,
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

/** Computes particle-position simplex noise for a callback or named particle.noise entry; octave count adds sampling cost. */
class NoiseModule extends Module {
    public octaves = 1;

    public frequency = 1;

    public lacunarity = 2.0;

    public persistence = 0.5;

    public time = 0;

    public offset = new THREE.Vector3();

    public key: string;

    /** Creates the modifier with its built-in priority and optional filtering/LOD settings. */
    constructor(
      key: string,
      options?: Partial<NoiseOptions>,
    );
    constructor(
      update: NoiseModuleUpdate,
      options?: Partial<NoiseOptions>,
    );
    constructor(
      keyOrUpdate: string | NoiseModuleUpdate,
      options: Partial<NoiseOptions> = {},
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

      super(modify, options);

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
}

export default NoiseModule;
