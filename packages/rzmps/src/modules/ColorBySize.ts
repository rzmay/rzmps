import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { ValueByParameter } from '../types/ValueByParameter';
import type { Node } from 'three/webgpu';
import evaluateByParameterColor from '../helpers/evaluateByParameterColor';
import evaluateByParameterNumber from '../helpers/evaluateByParameterNumber';
import {
  evaluateByParameterColorGPU,
  evaluateByParameterNumberGPU,} from '../helpers/evaluateByParameterGPU';

export type SizeRange = [number, number] | { min: number; max: number };

export interface ColorBySizeOptions extends Partial<ModuleOptions> {
    color: ValueByParameter<THREE.Color>;
    alpha: ValueByParameter<number>;
    sizeRange: SizeRange;
}

class ColorBySize extends Module {
  constructor(public options: Partial<ColorBySizeOptions> = {}) {

    super((particle: Particle) => {
      const t = this.getSizeTime(particle.scale.length());

      if (this.options.color !== undefined) {
        particle.color.multiply(evaluateByParameterColor(this.options.color, t));
      }
      if (this.options.alpha !== undefined) {
        particle.alpha *= evaluateByParameterNumber(this.options.alpha, t);
      }
    }, {
      priority: Module.Priority.Transient,
      ...options,
      modifyGPU: (particle) => {
          const t = this.getSizeTimeGPU(particle.scale.length());

          if (this.options.color !== undefined) {
            particle.color.assign(
              particle.color.mul(evaluateByParameterColorGPU(this.options.color, t)),
            );
          }
          if (this.options.alpha !== undefined) {
            particle.alpha.assign(
              particle.alpha.mul(evaluateByParameterNumberGPU(this.options.alpha, t, 1)),
            );
          }
        }
    });
  }

  private getSizeTime(size: number): number {
    const min = Array.isArray(this.options.sizeRange) ? this.options.sizeRange[0] : this.options.sizeRange?.min ?? 0;
    const max = Array.isArray(this.options.sizeRange) ? this.options.sizeRange[1] : this.options.sizeRange?.max ?? 1;
    if (max === min) return size >= max ? 1 : 0;

    return THREE.MathUtils.clamp(THREE.MathUtils.mapLinear(size, min, max, 0, 1), 0, 1);
  }

  private getSizeTimeGPU(size: Node<'float'>) {
    const min = Array.isArray(this.options.sizeRange) ? this.options.sizeRange[0] : this.options.sizeRange?.min ?? 0;
    const max = Array.isArray(this.options.sizeRange) ? this.options.sizeRange[1] : this.options.sizeRange?.max ?? 1;

    return size.sub(min).div(max - min || 1).clamp(0, 1);
  }
}

export default ColorBySize;
