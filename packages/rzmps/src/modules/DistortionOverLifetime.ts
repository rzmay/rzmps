import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';

export interface DistortionOverLifetimeOptions extends Partial<ModuleOptions> {
    distortionStrength: DynamicValue<number>;
}

class DistortionOverLifetime extends Module {
  constructor(public options: Partial<DistortionOverLifetimeOptions> = {}) {

    super((particle: Particle) => {
      particle.distortionStrength *= evaluateDynamicNumber(
        this.options.distortionStrength ?? 1,
        particle.time,
        particle.id,
      );
    }, {
      ...options,
      priority: 1,
    });
  }
}

export default DistortionOverLifetime;
