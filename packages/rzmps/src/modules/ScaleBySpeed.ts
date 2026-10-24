import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { ValueByParameter } from '../types/ValueByParameter';
import evaluateByParameterVector from '../helpers/evaluateByParameterVector3';
import type { Node } from 'three/webgpu';
import { SpeedRange } from './ColorBySpeed';

export interface ScaleBySpeedOptions extends Partial<ModuleOptions> {
    scale: ValueByParameter<THREE.Vector3>;
    scalarVelocity: ValueByParameter<THREE.Vector3>;
    scalarAcceleration: ValueByParameter<THREE.Vector3>;
    /** Velocity-magnitude interval mapped to zero through one; values outside it are clamped. */
    speedRange?: SpeedRange;
}

/** Multiplies scale and adds scalar channels using velocity magnitude normalized over speedRange; two-value parameter ranges interpolate rather than randomly sample. */
class ScaleBySpeed extends Module {
  /** Creates the modifier with its built-in priority and optional filtering/LOD settings. */
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
      priority: Module.Priority.Transient,
      modifyGPU: (particle) => {
          const time = this.getSpeedTimeGPU(particle.velocity.length());

          particle.scale.assign(
            particle.scale.mul(this.gpuParameters.parameterVector(
              'scale', () => this.options.scale,
              time,
              new THREE.Vector3(1, 1, 1),
            )),
          );
          particle.scalarVelocity.assign(
            particle.scalarVelocity.add(this.gpuParameters.parameterVector(
              'scalarVelocity', () => this.options.scalarVelocity,
              time,
            )),
          );
          particle.scalarAcceleration.assign(
            particle.scalarAcceleration.add(this.gpuParameters.parameterVector(
              'scalarAcceleration', () => this.options.scalarAcceleration,
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

export default ScaleBySpeed;
