import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import evaluateDynamicVector from '../helpers/evaluateDynamicVector3';
import {
  evaluateDynamicNumberGPU,
  evaluateDynamicVectorGPU,} from '../helpers/evaluateDynamicGPU';

export interface VelocityOverLifetimeOptions extends Partial<ModuleOptions> {
    position: DynamicValue<THREE.Vector3>;
    linear: DynamicValue<THREE.Vector3>;
    acceleration: DynamicValue<THREE.Vector3>;
    orbital: DynamicValue<THREE.Vector3>;
    orbitOffset: DynamicValue<THREE.Vector3>;
    radial: DynamicValue<number>;
    speedModifier: DynamicValue<number>;
}

class VelocityOverLifetime extends Module {
  constructor(public options: Partial<VelocityOverLifetimeOptions> = {}) {

    super((particle: Particle) => {
      const { time } = particle;

      if (this.options.position !== undefined) {
        particle.position.add(evaluateDynamicVector(this.options.position, time, particle.id));
      }

      if (this.options.linear !== undefined) {
        particle.velocity.add(evaluateDynamicVector(this.options.linear, time, particle.id));
      }

      if (this.options.acceleration !== undefined) {
        particle.acceleration.add(evaluateDynamicVector(this.options.acceleration, time, particle.id));
      }

      const offset = evaluateDynamicVector(this.options.orbitOffset ?? new THREE.Vector3(), time, particle.id).clone();
      const center = particle.orbitCenter.clone().add(offset);
      const fromCenter = particle.position.clone().sub(center);

      if (this.options.orbital !== undefined && fromCenter.lengthSq() > 0) {
        const angularVelocity = evaluateDynamicVector(this.options.orbital, time, particle.id).clone();
        particle.velocity.add(angularVelocity.cross(fromCenter.clone().normalize()));
      }

      if (this.options.radial !== undefined && fromCenter.lengthSq() > 0) {
        particle.velocity.add(
          fromCenter.normalize().multiplyScalar(
            evaluateDynamicNumber(this.options.radial, time, particle.id)
          )
        );
      }

      if (this.options.speedModifier !== undefined) {
        particle.speed *= evaluateDynamicNumber(this.options.speedModifier, time, particle.id);
      }
    }, {
      ...options,
      priority: 0.5,
      modifyGPU: (particle) => {
          if (this.options.position !== undefined) {
            particle.position.assign(
              particle.position.add(evaluateDynamicVectorGPU(
                this.options.position,
                particle.time,
                new THREE.Vector3(0, 0, 0),
                particle.index,
              )),
            );
          }

          if (this.options.linear !== undefined) {
            particle.velocity.assign(
              particle.velocity.add(evaluateDynamicVectorGPU(
                this.options.linear,
                particle.time,
                new THREE.Vector3(0, 0, 0),
                particle.index,
              )),
            );
          }

          if (this.options.acceleration !== undefined) {
            particle.acceleration.assign(
              particle.acceleration.add(evaluateDynamicVectorGPU(
                this.options.acceleration,
                particle.time,
                new THREE.Vector3(0, 0, 0),
                particle.index,
              )),
            );
          }

          const offset = evaluateDynamicVectorGPU(
            this.options.orbitOffset ?? new THREE.Vector3(),
            particle.time,
            new THREE.Vector3(),
            particle.index,
          );
          const center = particle.orbitCenter.add(offset);
          const fromCenter = particle.position.sub(center);
          const fromCenterDirection = fromCenter.normalize();

          if (this.options.orbital !== undefined) {
            const angularVelocity = evaluateDynamicVectorGPU(
              this.options.orbital,
              particle.time,
              new THREE.Vector3(0, 0, 0),
              particle.index,
            );

            particle.velocity.assign(
              particle.velocity.add(angularVelocity.cross(fromCenterDirection)),
            );
          }

          if (this.options.radial !== undefined) {
            particle.velocity.assign(
              particle.velocity.add(
                fromCenterDirection.mul(
                  evaluateDynamicNumberGPU(this.options.radial, particle.time, 0, particle.index),
                )
              ),
            );
          }

          if (this.options.speedModifier !== undefined) {
            particle.speed.assign(
              particle.speed.mul(
                evaluateDynamicNumberGPU(this.options.speedModifier, particle.time, 1, particle.index)
              ),
            );
          }
        }
    });
  }
}

export default VelocityOverLifetime;
