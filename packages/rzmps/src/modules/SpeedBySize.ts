import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { ValueByParameter } from '../types/ValueByParameter';
import evaluateByParameterNumber from '../helpers/evaluateByParameterNumber';
import { SizeRange } from './ColorBySize';

export interface SpeedBySizeOptions extends Partial<ModuleOptions> {
    speed: ValueByParameter<number>;
    sizeRange?: SizeRange;
}

class SpeedBySize extends Module {
  constructor(public options: Partial<SpeedBySizeOptions> = {}) {

    super((particle: Particle) => {
      particle.speed *= evaluateByParameterNumber(
        this.options.speed ?? 1,
        this.getSizeTime(particle.scale.length()),
      );
    }, {
      ...options,
      priority: Module.Priority.PreMovementTransient,
    });
  }

  private getSizeTime(size: number): number {
    const min = Array.isArray(this.options.sizeRange) ? this.options.sizeRange[0] : this.options.sizeRange?.min ?? 0;
    const max = Array.isArray(this.options.sizeRange) ? this.options.sizeRange[1] : this.options.sizeRange?.max ?? 1;
    if (max === min) return size >= max ? 1 : 0;

    return THREE.MathUtils.clamp(THREE.MathUtils.mapLinear(size, min, max, 0, 1), 0, 1);
  }

}

export default SpeedBySize;
