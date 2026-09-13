import * as THREE from 'three';
import Module, { ModuleOptions } from '../Module';
import Particle from '../Particle';
import { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicColor from '../helpers/evaluateDynamicColor';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';

export type SpeedRange = [number, number] | { min: number; max: number };

export interface ColorBySpeedOptions extends Partial<ModuleOptions> {
    color?: DynamicValue<THREE.Color>;
    alpha?: DynamicValue<number>;
    speedRange?: SpeedRange;
}

class ColorBySpeed extends Module {
  constructor(public options: ColorBySpeedOptions) {
    super((particle: Particle) => {
      const t = this.getSpeedTime(particle.velocity.length());

      if (this.options.color !== undefined) {
        particle.color = particle.start.color.clone().multiply(evaluateDynamicColor(this.options.color, t, particle.id));
      }
      if (this.options.alpha !== undefined) {
        particle.alpha = particle.start.alpha * evaluateDynamicNumber(this.options.alpha, t, particle.id);
      }
    }, options);
  }

  private getSpeedTime(speed: number): number {
    const min = Array.isArray(this.options.speedRange) ? this.options.speedRange[0] : this.options.speedRange?.min ?? 0;
    const max = Array.isArray(this.options.speedRange) ? this.options.speedRange[1] : this.options.speedRange?.max ?? 1;
    if (max === min) return speed >= max ? 1 : 0;

    return Math.min(Math.max((speed - min) / (max - min), 0), 1);
  }
}

export default ColorBySpeed;
