import * as THREE from 'three';
import Module, { ModuleOptions } from '../Module';
import Particle from '../Particle';
import { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import evaluateDynamicVector from '../helpers/evaluateDynamicVector3';
import NoiseModule, { NoiseOptions } from './NoiseModule';

export interface TransformByNoiseOptions extends Partial<ModuleOptions>, NoiseOptions {
    strength: DynamicValue<THREE.Vector3>;
    scrollSpeed: DynamicValue<number>;
    damping: boolean;
}

class TransformByNoise extends Module {
    private noiseX: NoiseModule;
    private noiseY: NoiseModule;
    private noiseZ: NoiseModule;

    constructor(public options: Partial<TransformByNoiseOptions>) {
      const key = `transformByNoise-${Math.random().toString(36).slice(2)}`;
      const noiseX = new NoiseModule(`${key}-x`, { ...options, offset: new THREE.Vector3(0, 0, 0) });
      const noiseY = new NoiseModule(`${key}-y`, { ...options, offset: new THREE.Vector3(31.416, 0, 0) });
      const noiseZ = new NoiseModule(`${key}-z`, { ...options, offset: new THREE.Vector3(0, 31.416, 0) });

      super((particle: Particle, deltaTime: number) => {
        const scrollSpeed = evaluateDynamicNumber(this.options.scrollSpeed ?? 0, particle.time, particle.id);
        const time = (particle.realtime / 1000) * scrollSpeed;

        this.noiseX.time = time;
        this.noiseY.time = time;
        this.noiseZ.time = time;

        const strength = evaluateDynamicVector(this.options.strength, particle.time, particle.id);
        if (this.options.damping) strength.multiplyScalar(1 / Math.max(this.options.frequency ?? 1, 1));

        const force = new THREE.Vector3(
          (particle.noise[this.noiseX.key].noise4d * 2 - 1) * strength.x,
          (particle.noise[this.noiseY.key].noise4d * 2 - 1) * strength.y,
          (particle.noise[this.noiseZ.key].noise4d * 2 - 1) * strength.z,
        );

        particle.velocity.addScaledVector(force, deltaTime);
      }, options);

      this.noiseX = noiseX;
      this.noiseY = noiseY;
      this.noiseZ = noiseZ;
      this.dependents.push(noiseX, noiseY, noiseZ);
    }
}

export default TransformByNoise;
