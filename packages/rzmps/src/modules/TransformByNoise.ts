import * as THREE from 'three';
import type { ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import evaluateDynamicVector from '../helpers/evaluateDynamicVector3';
import NoiseModule, { NoiseOptions } from './NoiseModule';

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
          (noiseX.noise4d * 2 - 1) * strength.x,
          (noiseY.noise4d * 2 - 1) * strength.y,
          (noiseZ.noise4d * 2 - 1) * strength.z,
        );

        particle.velocity.addScaledVector(force, deltaTime);
      }, { ...options });
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
      const noise = this.generateNoise(particle);
      this.time = previousTime;
      this.offset = previousOffset;
      return noise;
    }


}

export default TransformByNoise;
