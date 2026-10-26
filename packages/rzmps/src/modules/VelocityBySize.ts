import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { ValueByParameter } from '../types/ValueByParameter';
import type { Node } from 'three/webgpu';
import evaluateByParameterVector from '../helpers/evaluateByParameterVector3';
import { SizeRange } from './ColorBySize';

export interface VelocityBySizeOptions extends Partial<ModuleOptions> {
    position: ValueByParameter<THREE.Vector3>;
    velocity: ValueByParameter<THREE.Vector3>;
    acceleration: ValueByParameter<THREE.Vector3>;
    /** Particle-size interval mapped to zero through one; values outside it are clamped. */
    sizeRange: SizeRange;
}

/**
 * Adds linear motion channels using particle size normalized over sizeRange; two-value parameter ranges interpolate
 * rather than randomly sample.
 */
class VelocityBySize extends Module {
  /** Creates the modifier with its built-in priority and optional filtering/LOD settings. */
  constructor(public options: Partial<VelocityBySizeOptions> = {}) {

    super((particle: Particle) => {
      particle.position.add(
        evaluateByParameterVector(
          this.options.position ?? new THREE.Vector3(0, 0, 0),
          this.getSizeTime(particle.scale.length()),
        ),
      );
      particle.velocity.add(
        evaluateByParameterVector(
          this.options.velocity ?? new THREE.Vector3(0, 0, 0),
          this.getSizeTime(particle.scale.length()),
        ),
      );
      particle.acceleration.add(
        evaluateByParameterVector(
          this.options.acceleration ?? new THREE.Vector3(0, 0, 0),
          this.getSizeTime(particle.scale.length()),
        ),
      );
    }, {
      ...options,
      priority: Module.Priority.PreMovementTransient,
      modifyGPU: (particle) => {
          const time = this.getSizeTimeGPU(particle.scale.length());

          particle.position.assign(
            particle.position.add(this.gpuParameters.parameterVector(
              'position', () => this.options.position,
              time,
            )),
          );
          particle.velocity.assign(
            particle.velocity.add(this.gpuParameters.parameterVector(
              'velocity', () => this.options.velocity,
              time,
            )),
          );
          particle.acceleration.assign(
            particle.acceleration.add(this.gpuParameters.parameterVector(
              'acceleration', () => this.options.acceleration,
              time,
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

export default VelocityBySize;
