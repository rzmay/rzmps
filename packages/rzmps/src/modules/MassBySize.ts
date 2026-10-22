import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { ValueByParameter } from '../types/ValueByParameter';
import type { Node } from 'three/webgpu';
import evaluateByParameterNumber from '../helpers/evaluateByParameterNumber';
import { SizeRange } from './ColorBySize';

export interface MassBySizeOptions extends Partial<ModuleOptions> {
    mass: ValueByParameter<number>;
    /** Particle-size interval mapped to zero through one; values outside it are clamped. */
    sizeRange?: SizeRange;
}

/** Multiplies particle mass using particle size normalized over sizeRange; two-value parameter ranges interpolate rather than randomly sample. */
class MassBySize extends Module {
  /** Creates the modifier with its built-in priority and optional filtering/LOD settings. */
  constructor(public options: Partial<MassBySizeOptions> = {}) {

    super((particle: Particle) => {
      particle.mass *= evaluateByParameterNumber(
        this.options.mass ?? 1,
        this.getSizeTime(particle.scale.length()),
      );
    }, {
      ...options,
      priority: Module.Priority.Transient,
      modifyGPU: (particle) => {
          particle.mass.assign(
            particle.mass.mul(this.gpuParameters.parameterNumber(
              'mass',
              () => this.options.mass,
              this.getSizeTimeGPU(particle.scale.length()),
              1,
            )),
          );
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
    const min = this.gpuParameters.number('sizeRange.min', () => (
      Array.isArray(this.options.sizeRange) ? this.options.sizeRange[0] : this.options.sizeRange?.min
    ), size, 0);
    const max = this.gpuParameters.number('sizeRange.max', () => (
      Array.isArray(this.options.sizeRange) ? this.options.sizeRange[1] : this.options.sizeRange?.max
    ), size, 1);
    return size.sub(min).div(max.sub(min).max(Number.EPSILON)).clamp(0, 1);
  }
}

export default MassBySize;
