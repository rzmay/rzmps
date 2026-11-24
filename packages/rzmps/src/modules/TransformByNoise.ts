import type { Vector3Input } from '../values/valueInput.types';
import * as THREE from 'three';
import type { ModuleOptions } from '../core/Module';
import Particle from '../core/Particle';
import type { DynamicValue } from '../values/dynamicValue.types';
import evaluateDynamicNumber from '../values/evaluateDynamicNumber';
import evaluateDynamicVector from '../values/evaluateDynamicVector';
import { generateGPUParticleNoise4D, generateParticleNoise4D } from '../utils/noise.utils';
import NoiseModule, { NoiseOptions } from './NoiseModule';
import type { GPUParticleLike } from '../simulation/gpu/Particle';
import type { Node } from 'three/webgpu';
import { float, vec3 } from 'three/tsl';
import { TransformMode } from '../enums/TransformMode';

export interface TransformByNoiseOptions extends Partial<ModuleOptions>, NoiseOptions {
    /** Property affected by noise. Defaults to Velocity; enum keys and values are accepted. */
    transformMode: TransformMode | `${TransformMode}`;
    /** Per-axis amplitude sampled by normalized age: position offset, velocity change/second, or force. */
    strength: DynamicValue<Vector3Input>;
    /** Noise time advancement per second of simulation time; zero keeps the noise time slice fixed. */
    scrollSpeed: DynamicValue<number>;
    /** Attenuates noise strength when frequency exceeds one. */
    damping: boolean;
}

/**
 * Applies three decorrelated noise channels to position, velocity or force. Velocity is the default.
 */
class TransformByNoise extends NoiseModule {
    /** Particle property modified by the sampled noise. Defaults to Velocity. */
    transformMode: TransformByNoiseOptions['transformMode'];

    /** Creates the modifier with its built-in priority and optional filtering/LOD settings. */
    constructor(public options: Partial<TransformByNoiseOptions> = {}) {
      super((particle: Particle, deltaTime: number, _noise, context) => {
        const scrollSpeed = evaluateDynamicNumber(this.options.scrollSpeed ?? 0, particle.time, particle.id);
        const time = this.time + (context.system.getEmitterContext().elapsedTime ?? 0) * scrollSpeed;

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

        switch (this.transformMode) {
          case TransformMode.Position:
            particle.position.add(force);
            break;
          case TransformMode.Force: {
            const mass = Number.isFinite(particle.mass) && particle.mass > 0 ? particle.mass : 1;
            particle.acceleration.addScaledVector(force, 1 / mass);
            break;
          }
          default:
            particle.velocity.addScaledVector(force, deltaTime);
        }
      }, {
        ...options,
        modifyGPU: (particle: GPUParticleLike, deltaTime, _noise, context) => {
          let strength = this.evaluateDynamicGPU.vector(
            'strength',
            () => this.options.strength,
            particle.time,
            new THREE.Vector3(),
            particle.index,
          );
          if (this.options.damping) {
            strength = strength.div(Math.max(this.options.frequency ?? 1, 1));
          }
          const scrollSpeed = this.evaluateDynamicGPU.number(
            'scrollSpeed',
            () => this.options.scrollSpeed,
            particle.time,
            0,
            particle.index,
          );
          const time = context.elapsedTimeNode.mul(scrollSpeed).add(this.time);
          const noiseX = this.generateOffsetNoiseGPU(particle, time, new THREE.Vector3(0, 0, 0));
          const noiseY = this.generateOffsetNoiseGPU(particle, time, new THREE.Vector3(31.416, 0, 0));
          const noiseZ = this.generateOffsetNoiseGPU(particle, time, new THREE.Vector3(0, 31.416, 0));

          const force = vec3(
            noiseX.mul(2).sub(1).mul(strength.x),
            noiseY.mul(2).sub(1).mul(strength.y),
            noiseZ.mul(2).sub(1).mul(strength.z),
          );

          switch (this.transformMode) {
            case TransformMode.Position:
              particle.position.addAssign(force);
              break;
            case TransformMode.Force: {
              const mass = particle.mass.greaterThan(0).and(particle.mass.lessThanEqual(3.402823466e38))
                .select(particle.mass, float(1));
              particle.acceleration.addAssign(force.div(mass));
              break;
            }
            default:
              particle.velocity.addAssign(force.mul(deltaTime));
          }
        },
      });
      this.transformMode = options.transformMode ?? TransformMode.Velocity;
    }

    private generateOffsetNoise(
      particle: Particle,
      time: number,
      offset: THREE.Vector3,
    ) {
      const previousTime = this.time;
      const previousOffset = this.offset;
      this.time = time;
      this.offset = previousOffset.clone().add(offset);
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
      this.offset = previousOffset.clone().add(offset);
      const noise = generateGPUParticleNoise4D(particle.position, this, time);
      this.offset = previousOffset;
      return noise;
    }

}

export default TransformByNoise;
