import * as THREE from 'three';
import type { ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import evaluateDynamicVector from '../helpers/evaluateDynamicVector3';
import { generateGPUParticleNoise4D, generateParticleNoise4D } from '../helpers/noise';
import NoiseModule, { NoiseOptions } from './NoiseModule';
import type { GPUParticle } from '../GPUParticle';
import type { Node } from 'three/webgpu';
import { float, vec3 } from 'three/tsl';

export interface TransformByNoiseOptions extends Partial<ModuleOptions>, NoiseOptions {
    strength: DynamicValue<THREE.Vector3>;
    scrollSpeed: DynamicValue<number>;
    damping: boolean;
}

class TransformByNoise extends NoiseModule {
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
        modifyGPU: (particle: GPUParticle, deltaTime: number) => {
          const strength = this.getGPUStrength();
          const scrollSpeed = typeof this.options.scrollSpeed === 'number'
            ? this.options.scrollSpeed
            : 0;
          const time = particle.realtime.div(1000).mul(scrollSpeed);
          const noiseX = this.generateOffsetNoiseGPU(particle, time, new THREE.Vector3(0, 0, 0));
          const noiseY = this.generateOffsetNoiseGPU(particle, time, new THREE.Vector3(31.416, 0, 0));
          const noiseZ = this.generateOffsetNoiseGPU(particle, time, new THREE.Vector3(0, 31.416, 0));

          const force = vec3(
            noiseX.mul(2).sub(1).mul(strength.x),
            noiseY.mul(2).sub(1).mul(strength.y),
            noiseZ.mul(2).sub(1).mul(strength.z),
          );

          particle.velocity.assign(particle.velocity.add(force.mul(float(deltaTime))));
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
      particle: GPUParticle,
      time: Node<'float'>,
      offset: THREE.Vector3,
    ) {
      const previousOffset = this.offset;
      this.offset = offset;
      const noise = generateGPUParticleNoise4D(particle.position, this, time);
      this.offset = previousOffset;
      return noise;
    }

    private getGPUStrength(): THREE.Vector3 {
      const strength = this.options.strength instanceof THREE.Vector3
        ? this.options.strength.clone()
        : new THREE.Vector3();

      if (this.options.damping) {
        strength.multiplyScalar(1 / Math.max(this.options.frequency ?? 1, 1));
      }

      return strength;
    }
}

export default TransformByNoise;
