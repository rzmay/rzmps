import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { ValueByParameter } from '../types/ValueByParameter';
import type { Node } from 'three/webgpu';
import evaluateByParameterColor from '../helpers/evaluateByParameterColor';
import evaluateByParameterNumber from '../helpers/evaluateByParameterNumber';

export type SpeedRange = [number, number] | { min: number; max: number };

export interface ColorBySpeedOptions extends Partial<ModuleOptions> {
    color: ValueByParameter<THREE.Color>;
    alpha: ValueByParameter<number>;
    /** Velocity-magnitude interval mapped to zero through one; values outside it are clamped. */
    speedRange: SpeedRange;
}

/** Multiplies color and alpha using velocity magnitude normalized over speedRange; two-value parameter ranges interpolate rather than randomly sample. */
class ColorBySpeed extends Module {
  /** Creates the modifier with its built-in priority and optional filtering/LOD settings. */
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
      modifyGPU: (particle) => {
          const t = this.getSpeedTimeGPU(particle.velocity.length());

          if (this.options.color !== undefined) {
            particle.color.assign(
              particle.color.mul(this.gpuParameters.parameterColor(
                'color', () => this.options.color, t,
              )),
            );
          }
          if (this.options.alpha !== undefined) {
            particle.alpha.assign(
              particle.alpha.mul(this.gpuParameters.parameterNumber(
                'alpha', () => this.options.alpha, t, 1,
              )),
            );
          }
        }
    });
  }

  private getSpeedTime(speed: number): number {
    const min = Array.isArray(this.options.speedRange) ? this.options.speedRange[0] : this.options.speedRange?.min ?? 0;
    const max = Array.isArray(this.options.speedRange) ? this.options.speedRange[1] : this.options.speedRange?.max ?? 1;
    if (max === min) return speed >= max ? 1 : 0;

    return THREE.MathUtils.clamp(THREE.MathUtils.mapLinear(speed, min, max, 0, 1), 0, 1);
  }

  private getSpeedTimeGPU(speed: Node<'float'>) {
    const min = this.gpuParameters.number('speedRange.min', () => (
      Array.isArray(this.options.speedRange) ? this.options.speedRange[0] : this.options.speedRange?.min
    ), speed, 0);
    const max = this.gpuParameters.number('speedRange.max', () => (
      Array.isArray(this.options.speedRange) ? this.options.speedRange[1] : this.options.speedRange?.max
    ), speed, 1);
    return speed.sub(min).div(max.sub(min).max(Number.EPSILON)).clamp(0, 1);
  }
}

export default ColorBySpeed;
