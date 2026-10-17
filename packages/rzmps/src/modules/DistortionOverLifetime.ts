import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';

export interface DistortionOverLifetimeOptions extends Partial<ModuleOptions> {
    distortionStrength: DynamicValue<number>;
}

/** Applies a transient distortion multiplier by normalized age; requires a renderer material that consumes distortionStrength. */
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
    });
  }
}

export default DistortionOverLifetime;
