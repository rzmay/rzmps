import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { ValueByParameter } from '../types/ValueByParameter';
import type { Node } from 'three/webgpu';
import evaluateByParameterNumber from '../helpers/evaluateByParameterNumber';
import {
  evaluateByParameterNumberGPU,} from '../helpers/evaluateByParameterGPU';
import { SizeRange } from './ColorBySize';

export interface DistortionBySizeOptions extends Partial<ModuleOptions> {
    distortionStrength: ValueByParameter<number>;
    sizeRange?: SizeRange;
}

class DistortionBySize extends Module {
  constructor(public options: Partial<DistortionBySizeOptions> = {}) {

    super((particle: Particle) => {
      particle.distortionStrength *= evaluateByParameterNumber(
        this.options.distortionStrength ?? 1,
        this.getSizeTime(particle.scale.length()),
      );
    }, {
      priority: 1,
      ...options,
      modifyGPU: (particle) => {
          particle.distortionStrength.assign(
            particle.distortionStrength.mul(evaluateByParameterNumberGPU(
              this.options.distortionStrength ?? 1,
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
    const min = Array.isArray(this.options.sizeRange) ? this.options.sizeRange[0] : this.options.sizeRange?.min ?? 0;
    const max = Array.isArray(this.options.sizeRange) ? this.options.sizeRange[1] : this.options.sizeRange?.max ?? 1;

    return size.sub(min).div(max - min || 1).clamp(0, 1);
  }
}

export default DistortionBySize;
