import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import type { Node } from 'three/webgpu';
import { abs, float, max, sign, vec3 } from 'three/tsl';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import evaluateDynamicVector from '../helpers/evaluateDynamicVector3';
import {
  evaluateDynamicNumberGPU,
  evaluateDynamicVectorGPU,} from '../helpers/evaluateDynamicGPU';

export interface LimitVelocityOverLifetimeOptions extends Partial<ModuleOptions> {
    limit: DynamicValue<THREE.Vector3>;
    dampen: number;
    drag: DynamicValue<number>;
    multiplyDragBySize: boolean;
    multiplyDragByVelocity: boolean;
}

class LimitVelocityOverLifetime extends Module {
  constructor(public options: Partial<LimitVelocityOverLifetimeOptions> = {}) {

    super((particle: Particle, deltaTime: number) => {
      const limit = evaluateDynamicVector(
        this.options.limit ?? new THREE.Vector3(1, 1, 1),
        particle.time,
        particle.id
      );
      const dampen = this.options.dampen ?? 1;

      this.dampenAxis(particle.velocity, 'x', Math.abs(limit.x), dampen);
      this.dampenAxis(particle.velocity, 'y', Math.abs(limit.y), dampen);
      this.dampenAxis(particle.velocity, 'z', Math.abs(limit.z), dampen);

      if (this.options.drag !== undefined) {
        let drag = evaluateDynamicNumber(this.options.drag, particle.time, particle.id);
        if (this.options.multiplyDragBySize) {
          drag *= (particle.scale.x + particle.scale.y + particle.scale.z) / 3;
        }
        if (this.options.multiplyDragByVelocity) {
          drag *= particle.velocity.length();
        }

        particle.velocity.multiplyScalar(Math.max(0, 1 - drag * deltaTime));
      }
    }, {
      ...options,
      modifyGPU: (particle, deltaTime) => {
          const limit = evaluateDynamicVectorGPU(
            this.options.limit ?? new THREE.Vector3(1, 1, 1),
            particle.time,
            new THREE.Vector3(1, 1, 1),
            particle.index,
          );
          const dampen = Math.min(Math.max(this.options.dampen ?? 1, 0), 1);

          particle.velocity.assign(vec3(
            this.dampenAxisGPU(particle.velocity.x, abs(limit.x), dampen),
            this.dampenAxisGPU(particle.velocity.y, abs(limit.y), dampen),
            this.dampenAxisGPU(particle.velocity.z, abs(limit.z), dampen),
          ));

          if (this.options.drag !== undefined) {
            let drag = evaluateDynamicNumberGPU(this.options.drag, particle.time, 0, particle.index);
            if (this.options.multiplyDragBySize) {
              drag = drag.mul(particle.scale.x.add(particle.scale.y).add(particle.scale.z).div(3));
            }
            if (this.options.multiplyDragByVelocity) {
              drag = drag.mul(particle.velocity.length());
            }

            particle.velocity.assign(
              particle.velocity.mul(max(float(0), float(1).sub(drag.mul(deltaTime)))),
            );
          }
        }
    });
  }

  // eslint-disable-next-line class-methods-use-this
  private dampenAxis(
    velocity: THREE.Vector3,
    axis: 'x' | 'y' | 'z',
    limit: number,
    dampen: number,
  ) {
    if (Math.abs(velocity[axis]) <= limit) return;

    const clamped = Math.sign(velocity[axis]) * limit;
    velocity[axis] += (clamped - velocity[axis]) * Math.min(Math.max(dampen, 0), 1);
  }

  // eslint-disable-next-line class-methods-use-this
  private dampenAxisGPU(
    velocity: Node<'float'>,
    limit: Node<'float'>,
    dampen: number,
  ): Node<'float'> {
    const clamped = sign(velocity).mul(limit);
    const dampened = velocity.add(clamped.sub(velocity).mul(dampen));

    return abs(velocity).greaterThan(limit).select(dampened, velocity);
  }
}

export default LimitVelocityOverLifetime;
