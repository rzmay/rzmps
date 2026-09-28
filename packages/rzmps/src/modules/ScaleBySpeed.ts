import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { ValueByParameter } from '../types/ValueByParameter';
import evaluateByParameterVector from '../helpers/evaluateByParameterVector3';
import { SpeedRange } from './ColorBySpeed';

export interface ScaleBySpeedOptions extends Partial<ModuleOptions> {
    scale: ValueByParameter<THREE.Vector3>;
    scalarVelocity: ValueByParameter<THREE.Vector3>;
    scalarAcceleration: ValueByParameter<THREE.Vector3>;
    speedRange?: SpeedRange;
}

class ScaleBySpeed extends Module {
  constructor(public options: Partial<ScaleBySpeedOptions> = {}) {

    super((particle: Particle) => {
      const time = this.getSpeedTime(particle.velocity.length());

      particle.scale.multiply(
        evaluateByParameterVector(
          this.options.scale ?? new THREE.Vector3(1, 1, 1),
          time,
        ),
      );
      particle.scalarVelocity.add(
        evaluateByParameterVector(
          this.options.scalarVelocity ?? new THREE.Vector3(),
          time,
        ),
      );
      particle.scalarAcceleration.add(
        evaluateByParameterVector(
          this.options.scalarAcceleration ?? new THREE.Vector3(),
          time,
        ),
      );
    }, {
      ...options,
      priority: 1,
    });
  }

  private getSpeedTime(speed: number): number {
    const min = Array.isArray(this.options.speedRange) ? this.options.speedRange[0] : this.options.speedRange?.min ?? 0;
    const max = Array.isArray(this.options.speedRange) ? this.options.speedRange[1] : this.options.speedRange?.max ?? 1;
    if (max === min) return speed >= max ? 1 : 0;

    return THREE.MathUtils.clamp(THREE.MathUtils.mapLinear(speed, min, max, 0, 1), 0, 1);
  }

}

export default ScaleBySpeed;
