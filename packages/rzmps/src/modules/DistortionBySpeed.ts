import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { ValueByParameter } from '../types/ValueByParameter';
import type { Node } from 'three/webgpu';
import evaluateByParameterNumber from '../helpers/evaluateByParameterNumber';
import {
  evaluateByParameterNumberGPU,} from '../helpers/evaluateByParameterGPU';
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
      priority: 1,
      ...options,
      modifyGPU: (particle) => {
          particle.distortionStrength.assign(
            particle.distortionStrength.mul(
              evaluateByParameterNumberGPU(
                this.options.distortionStrength ?? 1,
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
    const min = Array.isArray(this.options.speedRange) ? this.options.speedRange[0] : this.options.speedRange?.min ?? 0;
    const max = Array.isArray(this.options.speedRange) ? this.options.speedRange[1] : this.options.speedRange?.max ?? 1;

    return speed.sub(min).div(max - min || 1).clamp(0, 1);
  }
}

export default DistortionBySpeed;
