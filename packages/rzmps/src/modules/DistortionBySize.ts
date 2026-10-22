import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { ValueByParameter } from '../types/ValueByParameter';
import evaluateByParameterNumber from '../helpers/evaluateByParameterNumber';
import { SizeRange } from './ColorBySize';

export interface DistortionBySizeOptions extends Partial<ModuleOptions> {
    distortionStrength: ValueByParameter<number>;
    /** Particle-size interval mapped to zero through one; values outside it are clamped. */
    sizeRange?: SizeRange;
}

/** Multiplies distortion strength using particle size normalized over sizeRange; two-value parameter ranges interpolate rather than randomly sample. */
class DistortionBySize extends Module {
  /** Creates the modifier with its built-in priority and optional filtering/LOD settings. */
  constructor(public options: Partial<DistortionBySizeOptions> = {}) {

    super((particle: Particle) => {
      particle.distortionStrength *= evaluateByParameterNumber(
        this.options.distortionStrength ?? 1,
        this.getSizeTime(particle.scale.length()),
      );
    }, {
      ...options,
      priority: Module.Priority.Transient,
    });
  }

  private getSizeTime(size: number): number {
    const min = Array.isArray(this.options.sizeRange) ? this.options.sizeRange[0] : this.options.sizeRange?.min ?? 0;
    const max = Array.isArray(this.options.sizeRange) ? this.options.sizeRange[1] : this.options.sizeRange?.max ?? 1;
    if (max === min) return size >= max ? 1 : 0;

    return THREE.MathUtils.clamp(THREE.MathUtils.mapLinear(size, min, max, 0, 1), 0, 1);
  }

}

export default DistortionBySize;
