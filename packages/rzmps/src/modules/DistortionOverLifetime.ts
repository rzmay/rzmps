import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import {
  evaluateDynamicNumberGPU,} from '../helpers/evaluateDynamicGPU';

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
      priority: 1,
      ...options,
      modifyGPU: (particle) => {
          particle.distortionStrength.assign(
            particle.distortionStrength.mul(
              evaluateDynamicNumberGPU(this.options.distortionStrength ?? 1, particle.time, 1, particle.index),
            ),
          );
        }
    });
  }
}

export default DistortionOverLifetime;
