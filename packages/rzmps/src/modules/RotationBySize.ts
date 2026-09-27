import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { ValueByParameter } from '../types/ValueByParameter';
import evaluateByParameterVector from '../helpers/evaluateByParameterVector3';
import { SizeRange } from './ColorBySize';

export interface RotationBySizeOptions extends Partial<ModuleOptions> {
    angularVelocity: ValueByParameter<THREE.Vector3>;
    sizeRange: SizeRange;
}

class RotationBySize extends Module {
  constructor(public options: Partial<RotationBySizeOptions> = {}) {
    super((particle: Particle) => {
      particle.angularVelocity = particle.start.angularVelocity.clone().add(
        evaluateByParameterVector(
          this.options.angularVelocity ?? new THREE.Vector3(0, 0, 0),
          this.getSizeTime(particle.scale.length()),
        ),
      );
    }, options);
  }

  private getSizeTime(size: number): number {
    const min = Array.isArray(this.options.sizeRange) ? this.options.sizeRange[0] : this.options.sizeRange?.min ?? 0;
    const max = Array.isArray(this.options.sizeRange) ? this.options.sizeRange[1] : this.options.sizeRange?.max ?? 1;
    if (max === min) return size >= max ? 1 : 0;

    return THREE.MathUtils.clamp(THREE.MathUtils.mapLinear(size, min, max, 0, 1), 0, 1);
  }
}

export default RotationBySize;
