import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { ValueByParameter } from '../types/ValueByParameter';
import evaluateByParameterColor from '../helpers/evaluateByParameterColor';
import evaluateByParameterNumber from '../helpers/evaluateByParameterNumber';

export type SpeedRange = [number, number] | { min: number; max: number };

export interface ColorBySpeedOptions extends Partial<ModuleOptions> {
    color: ValueByParameter<THREE.Color>;
    alpha: ValueByParameter<number>;
    speedRange: SpeedRange;
}

class ColorBySpeed extends Module {
  constructor(public options: Partial<ColorBySpeedOptions> = {}) {

    super((particle: Particle) => {
      const t = this.getSpeedTime(particle.velocity.length());

      if (this.options.color !== undefined) {
        particle.color.multiply(evaluateByParameterColor(this.options.color, t));
      }
      if (this.options.alpha !== undefined) {
        particle.alpha *= evaluateByParameterNumber(this.options.alpha, t);
      }
    }, {
      ...options,
      priority: Module.Priority.Transient,
    });
  }

  private getSpeedTime(speed: number): number {
    const min = Array.isArray(this.options.speedRange) ? this.options.speedRange[0] : this.options.speedRange?.min ?? 0;
    const max = Array.isArray(this.options.speedRange) ? this.options.speedRange[1] : this.options.speedRange?.max ?? 1;
    if (max === min) return speed >= max ? 1 : 0;

    return THREE.MathUtils.clamp(THREE.MathUtils.mapLinear(speed, min, max, 0, 1), 0, 1);
  }

}

export default ColorBySpeed;
