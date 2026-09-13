import { makeNoise4D } from 'fast-simplex-noise';
import * as THREE from 'three';
import Module, { ModuleOptions } from '../Module';
import Particle from '../Particle';

export interface NoiseOptions extends Partial<ModuleOptions> {
    octaves: number;
    frequency: number;
    lacunarity: number;
    persistence: number;
    time: number;
    offset: THREE.Vector3;
}

class NoiseModule extends Module {
    public octaves = 1;

    public frequency = 1;

    public lacunarity = 2.0;

    public persistence = 0.5;

    public time = 0;

    public offset = new THREE.Vector3();

    public key: string;

    private noiseGenerator = makeNoise4D();

    constructor(key: string, options: Partial<NoiseOptions> = {}) {
      super((particle: Particle) => {
        particle.noise[key] = {
          noise: this.generateNoise(particle),
          noise4d: this.generateNoise(particle, true),
        };
      }, options);

      this.key = key;
      this.octaves = options.octaves ?? this.octaves;
      this.frequency = options.frequency ?? this.frequency;
      this.lacunarity = options.lacunarity ?? this.lacunarity;
      this.persistence = options.persistence ?? this.persistence;
      this.time = options.time ?? this.time;
      this.offset = options.offset ?? this.offset;
    }

    private generateNoise(particle: Particle, w = false): number {
      const layers = [];
      for (let i = 0; i < this.octaves; i += 1) {
        const frequency = this.frequency * (this.lacunarity ** i);
        const amplitude = this.persistence ** i;

        // Clamp because float math is nuts
        const rawNoise = Math.min(Math.max((this.noiseGenerator(
          (particle.position.x + this.offset.x) * frequency,
          (particle.position.y + this.offset.y) * frequency,
          (particle.position.z + this.offset.z) * frequency,
          w ? this.time : 0,
        ) + 1) / 2, 0), 1);

        layers.push({
          value: rawNoise * amplitude,
          weight: amplitude,
        });
      }

      // Use weighted average to maintain 0 - 1 range
      return layers.map((layer) => layer.value).reduce((a, b) => a + b)
          / layers.map((layer) => layer.weight).reduce((a, b) => a + b);
    }
}

export default NoiseModule;
