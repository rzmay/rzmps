import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { ValueByParameter } from '../types/ValueByParameter';
import type { Node } from 'three/webgpu';
import evaluateByParameterNumber from '../helpers/evaluateByParameterNumber';
import { SpeedRange } from './ColorBySpeed';

export interface DistortionBySpeedOptions extends Partial<ModuleOptions> {
    distortionStrength: ValueByParameter<number>;
    speedRange?: SpeedRange;
}

class DistortionBySpeed extends Module {
  constructor(public options: Partial<DistortionBySpeedOptions> = {}) {

    super((particle: Particle) => {
      particle.distortionStrength *= evaluateByParameterNumber(
        this.options.distortionStrength ?? 1,
        this.getSpeedTime(particle.velocity.length()),
      );
    }, {
      ...options,
      priority: Module.Priority.Transient,
      modifyGPU: (particle) => {
          particle.distortionStrength.assign(
            particle.distortionStrength.mul(
              this.gpuParameters.parameterNumber(
                'distortionStrength',
                () => this.options.distortionStrength,
                this.getSpeedTimeGPU(particle.velocity.length()),
                1,
              ),
            ),
          );
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

export default DistortionBySpeed;
