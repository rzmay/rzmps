import Module, { type ModuleOptions } from '../core/Module';
import Particle from '../core/Particle';
import type { DynamicValue } from '../values/dynamicValue.types';
import evaluateDynamicNumber from '../values/evaluateDynamicNumber';

export interface DistortionOverLifetimeOptions extends Partial<ModuleOptions> {
    distortionStrength: DynamicValue<number>;
}

/**
 * Applies a transient distortion multiplier by normalized age; requires a renderer material that consumes
 * distortionStrength.
 */
class DistortionOverLifetime extends Module {
  /** Creates the modifier with its built-in priority and optional filtering/LOD settings. */
  constructor(public options: Partial<DistortionOverLifetimeOptions> = {}) {

    super((particle: Particle) => {
      particle.distortionStrength *= evaluateDynamicNumber(
        this.options.distortionStrength ?? 1,
        particle.time,
        particle.id,
      );
    }, {
      ...options,
      priority: Module.Priority.Transient,
      modifyGPU: (particle) => {
          particle.distortionStrength.assign(
            particle.distortionStrength.mul(
              this.evaluateDynamicGPU.number(
                'distortionStrength',
                () => this.options.distortionStrength,
                particle.time,
                1,
                particle.index,
              ),
            ),
          );
        }
    });
  }
}

export default DistortionOverLifetime;
