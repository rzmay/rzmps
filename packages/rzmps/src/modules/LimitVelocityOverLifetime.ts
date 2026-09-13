import * as THREE from 'three';
import Module, { ModuleOptions } from '../Module';
import Particle from '../Particle';
import { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import evaluateDynamicVector from '../helpers/evaluateDynamicVector3';

export interface LimitVelocityOverLifetimeOptions extends Partial<ModuleOptions> {
    limit: DynamicValue<THREE.Vector3>;
    dampen?: number;
    drag?: DynamicValue<number>;
    multiplyDragBySize?: boolean;
    multiplyDragByVelocity?: boolean;
}

class LimitVelocityOverLifetime extends Module {
  constructor(public options: LimitVelocityOverLifetimeOptions) {
    super((particle: Particle, deltaTime: number) => {
      const limit = evaluateDynamicVector(this.options.limit, particle.time, particle.id);
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
    }, options);
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
}

export default LimitVelocityOverLifetime;
