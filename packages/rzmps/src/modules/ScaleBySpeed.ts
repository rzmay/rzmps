import * as THREE from 'three';
import Module, { ModuleOptions } from '../Module';
import Particle from '../Particle';
import { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicVector from '../helpers/evaluateDynamicVector3';
import { SpeedRange } from './ColorBySpeed';

export interface ScaleBySpeedOptions extends Partial<ModuleOptions> {
    scale: DynamicValue<THREE.Vector3>;
    speedRange?: SpeedRange;
}

class ScaleBySpeed extends Module {
  constructor(public options: ScaleBySpeedOptions) {
    super((particle: Particle) => {
      particle.scale = particle.start.scale.clone().multiply(
        evaluateDynamicVector(this.options.scale, this.getSpeedTime(particle.velocity.length()), particle.id),
      );
    }, options);
  }

  private getSpeedTime(speed: number): number {
    const min = Array.isArray(this.options.speedRange) ? this.options.speedRange[0] : this.options.speedRange?.min ?? 0;
    const max = Array.isArray(this.options.speedRange) ? this.options.speedRange[1] : this.options.speedRange?.max ?? 1;
    if (max === min) return speed >= max ? 1 : 0;

    return Math.min(Math.max((speed - min) / (max - min), 0), 1);
  }
}

export default ScaleBySpeed;
