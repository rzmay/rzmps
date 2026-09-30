import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { ValueByParameter } from '../types/ValueByParameter';
import evaluateByParameterVector from '../helpers/evaluateByParameterVector3';
import { SpeedRange } from './ColorBySpeed';

export interface RotationBySpeedOptions extends Partial<ModuleOptions> {
    angle: ValueByParameter<THREE.Vector3>;
    angularVelocity: ValueByParameter<THREE.Vector3>;
    angularAcceleration: ValueByParameter<THREE.Vector3>;
    speedRange: SpeedRange;
}

class RotationBySpeed extends Module {
  constructor(public options: Partial<RotationBySpeedOptions> = {}) {

    super((particle: Particle) => {
      particle.rotation.add(
        evaluateByParameterVector(
          this.options.angle ?? new THREE.Vector3(0, 0, 0),
          this.getSpeedTime(particle.velocity.length()),
        ),
      );
      particle.angularVelocity.add(
        evaluateByParameterVector(
          this.options.angularVelocity ?? new THREE.Vector3(0, 0, 0),
          this.getSpeedTime(particle.velocity.length()),
        ),
      );
      particle.angularAcceleration.add(
        evaluateByParameterVector(
          this.options.angularAcceleration ?? new THREE.Vector3(0, 0, 0),
          this.getSpeedTime(particle.velocity.length()),
        ),
      );
    }, {
      ...options,
      priority: Module.Priority.PreMovementTransient,
    });
  }

  private getSpeedTime(speed: number): number {
    const min = Array.isArray(this.options.speedRange) ? this.options.speedRange[0] : this.options.speedRange?.min ?? 0;
    const max = Array.isArray(this.options.speedRange) ? this.options.speedRange[1] : this.options.speedRange?.max ?? 1;
    if (max === min) return speed >= max ? 1 : 0;

    return THREE.MathUtils.clamp(THREE.MathUtils.mapLinear(speed, min, max, 0, 1), 0, 1);
  }

}

export default RotationBySpeed;
