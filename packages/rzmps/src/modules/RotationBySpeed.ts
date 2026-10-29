import type { Vector3Input } from '../types/ValueInput';
import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { ValueByParameter } from '../types/ValueByParameter';
import type { Node } from 'three/webgpu';
import evaluateByParameterVector from '../helpers/evaluateByParameterVector3';
import { SpeedRange } from './ColorBySpeed';

export interface RotationBySpeedOptions extends Partial<ModuleOptions> {
    /** Angular values are radians; scalar inputs expand uniformly across axes. */
    angle: ValueByParameter<Vector3Input>;
    angularVelocity: ValueByParameter<Vector3Input>;
    angularAcceleration: ValueByParameter<Vector3Input>;
    /** Velocity-magnitude interval mapped to zero through one; values outside it are clamped. */
    speedRange: SpeedRange;
}

/**
 * Adds angular channels using velocity magnitude normalized over speedRange; two-value parameter ranges interpolate
 * rather than randomly sample.
 */
class RotationBySpeed extends Module {
  /** Creates the modifier with its built-in priority and optional filtering/LOD settings. */
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
      modifyGPU: (particle) => {
          const time = this.getSpeedTimeGPU(particle.velocity.length());

          particle.rotation.assign(
            particle.rotation.add(this.gpuParameters.parameterVector(
              'angle', () => this.options.angle,
              time,
            )),
          );
          particle.angularVelocity.assign(
            particle.angularVelocity.add(this.gpuParameters.parameterVector(
              'angularVelocity', () => this.options.angularVelocity,
              time,
            )),
          );
          particle.angularAcceleration.assign(
            particle.angularAcceleration.add(this.gpuParameters.parameterVector(
              'angularAcceleration', () => this.options.angularAcceleration,
              time,
            )),
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

export default RotationBySpeed;
