import type { ColorInput } from '../values/valueInput.types';
import * as THREE from 'three';
import Module, { type ModuleOptions } from '../core/Module';
import Particle from '../core/Particle';
import type { ValueByParameter } from '../values/valueByParameter.types';
import type { Node } from 'three/webgpu';
import evaluateByParameterColor from '../values/evaluateByParameterColor';
import evaluateByParameterNumber from '../values/evaluateByParameterNumber';

export type SizeRange = [number, number] | { min: number; max: number };

export interface ColorBySizeOptions extends Partial<ModuleOptions> {
    color: ValueByParameter<ColorInput>;
    alpha: ValueByParameter<number>;
    /** Particle-size interval mapped to zero through one; values outside it are clamped. */
    sizeRange: SizeRange;
}

/**
 * Multiplies color and alpha using particle size normalized over sizeRange; two-value parameter ranges interpolate
 * rather than randomly sample.
 */
class ColorBySize extends Module {
  /** Creates the modifier with its built-in priority and optional filtering/LOD settings. */
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
              particle.color.mul(this.evaluateDynamicGPU.parameterColor(
                'color', () => this.options.color, t,
              )),
            );
          }
          if (this.options.alpha !== undefined) {
            particle.alpha.assign(
              particle.alpha.mul(this.evaluateDynamicGPU.parameterNumber(
                'alpha', () => this.options.alpha, t, 1,
              )),
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
    const min = this.evaluateDynamicGPU.number('sizeRange.min', () => (
      Array.isArray(this.options.sizeRange) ? this.options.sizeRange[0] : this.options.sizeRange?.min
    ), size, 0);
    const max = this.evaluateDynamicGPU.number('sizeRange.max', () => (
      Array.isArray(this.options.sizeRange) ? this.options.sizeRange[1] : this.options.sizeRange?.max
    ), size, 1);
    return size.sub(min).div(max.sub(min).max(Number.EPSILON)).clamp(0, 1);
  }
}

export default ColorBySize;
