import type { Vector3Input } from '../types/ValueInput';
import * as THREE from 'three';
import type { ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import evaluateDynamicVector from '../helpers/evaluateDynamicVector3';
import { generateGPUParticleNoise4D, generateParticleNoise4D } from '../helpers/noise';
import NoiseModule, { NoiseOptions } from './NoiseModule';
import type { GPUParticleLike } from '../gpu/Particle';
import type { Node } from 'three/webgpu';
import { vec3 } from 'three/tsl';

export interface TransformByNoiseOptions extends Partial<ModuleOptions>, NoiseOptions {
    /** Per-axis noise force amplitude sampled by normalized age. */
    strength: DynamicValue<Vector3Input>;
    /** Noise time advancement per second of particle age; zero keeps the noise time slice fixed. */
    scrollSpeed: DynamicValue<number>;
    /** Attenuates noise strength when frequency exceeds one. */
    damping: boolean;
}

/**
 * Adds three decorrelated noise channels to velocity using delta seconds; supply strength for the desired per-axis
 * response.
 */
class TransformByNoise extends NoiseModule {
    /** Creates the modifier with its built-in priority and optional filtering/LOD settings. */
    constructor(public options: Partial<TransformByNoiseOptions> = {}) {
      super((particle: Particle, deltaTime: number) => {
        const scrollSpeed = evaluateDynamicNumber(this.options.scrollSpeed ?? 0, particle.time, particle.id);
        const time = (particle.realtime / 1000) * scrollSpeed;

        const strength = evaluateDynamicVector(this.options.strength, particle.time, particle.id);
        if (this.options.damping) strength.multiplyScalar(1 / Math.max(this.options.frequency ?? 1, 1));

        const noiseX = this.generateOffsetNoise(particle, time, new THREE.Vector3(0, 0, 0));
        const noiseY = this.generateOffsetNoise(particle, time, new THREE.Vector3(31.416, 0, 0));
        const noiseZ = this.generateOffsetNoise(particle, time, new THREE.Vector3(0, 31.416, 0));

        const force = new THREE.Vector3(
          (noiseX * 2 - 1) * strength.x,
          (noiseY * 2 - 1) * strength.y,
          (noiseZ * 2 - 1) * strength.z,
        );

        particle.velocity.addScaledVector(force, deltaTime);
      }, {
        ...options,
        modifyGPU: (particle: GPUParticleLike, deltaTime) => {
          let strength = this.gpuParameters.vector(
            'strength',
            () => this.options.strength,
            particle.time,
            new THREE.Vector3(),
            particle.index,
          );
          if (this.options.damping) {
            strength = strength.div(Math.max(this.options.frequency ?? 1, 1));
          }
          const scrollSpeed = this.gpuParameters.number(
            'scrollSpeed',
            () => this.options.scrollSpeed,
            particle.time,
            0,
            particle.index,
          );
          const time = particle.realtime.div(1000).mul(scrollSpeed);
          const noiseX = this.generateOffsetNoiseGPU(particle, time, new THREE.Vector3(0, 0, 0));
          const noiseY = this.generateOffsetNoiseGPU(particle, time, new THREE.Vector3(31.416, 0, 0));
          const noiseZ = this.generateOffsetNoiseGPU(particle, time, new THREE.Vector3(0, 31.416, 0));

          const force = vec3(
            noiseX.mul(2).sub(1).mul(strength.x),
            noiseY.mul(2).sub(1).mul(strength.y),
            noiseZ.mul(2).sub(1).mul(strength.z),
          );

          particle.velocity.assign(particle.velocity.add(force.mul(deltaTime)));
        },
      });
    }

    private generateOffsetNoise(
      particle: Particle,
      time: number,
      offset: THREE.Vector3,
    ) {
      const previousTime = this.time;
      const previousOffset = this.offset;
      this.time = time;
      this.offset = offset;
      const noise = generateParticleNoise4D(particle.position, this);
      this.time = previousTime;
      this.offset = previousOffset;
      return noise;
    }

    private generateOffsetNoiseGPU(
      particle: GPUParticleLike,
      time: Node<'float'>,
      offset: THREE.Vector3,
    ) {
      const previousOffset = this.offset;
      this.offset = offset;
      const noise = generateGPUParticleNoise4D(particle.position, this, time);
      this.offset = previousOffset;
      return noise;
    }

}

export default TransformByNoise;
