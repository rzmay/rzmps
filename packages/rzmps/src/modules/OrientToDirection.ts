import * as THREE from 'three';
import { asin, atan, float, If, vec3, vec4 } from 'three/tsl';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';

export interface OrientToDirectionOptions extends Partial<ModuleOptions> {
  axis: THREE.Vector3;
}

class OrientToDirection extends Module {
  private axis = new THREE.Vector3(0, 1, 0);
  private direction = new THREE.Vector3();
  private quaternion = new THREE.Quaternion();
  private euler = new THREE.Euler();

  constructor(public options: Partial<OrientToDirectionOptions> = {}) {
    super((particle: Particle) => {
      this.direction.copy(particle.velocity);
      if (this.direction.lengthSq() <= Number.EPSILON) return;

      this.axis.copy(this.options.axis ?? new THREE.Vector3(0, 1, 0));
      if (this.axis.lengthSq() <= Number.EPSILON) this.axis.set(0, 1, 0);

      this.axis.normalize();
      this.direction.normalize();
      this.quaternion.setFromUnitVectors(this.axis, this.direction);
      this.euler.setFromQuaternion(this.quaternion);
      particle.rotation.set(this.euler.x, this.euler.y, this.euler.z);
    }, {
      ...options,
      priority: Module.Priority.Transient,
      modifyGPU: (particle) => {
        If(particle.velocity.lengthSq().greaterThan(float(Number.EPSILON)), () => {
          const sourceAxis = (options.axis ?? new THREE.Vector3(0, 1, 0)).clone();
          if (sourceAxis.lengthSq() <= Number.EPSILON) sourceAxis.set(0, 1, 0);
          sourceAxis.normalize();

          const axis = vec3(sourceAxis);
          const direction = particle.velocity.normalize();
          const quaternion = vec4(
            axis.cross(direction),
            float(1).add(axis.dot(direction)),
          ).toVar('orientationQuaternion');

          If(quaternion.lengthSq().lessThan(float(Number.EPSILON)), () => {
            const orthogonal = axis.x.abs().lessThan(float(0.9))
              .select(vec3(1, 0, 0), vec3(0, 0, 1));
            quaternion.assign(vec4(axis.cross(orthogonal).normalize(), 0));
          });
          quaternion.assign(quaternion.normalize());

          const sinPitch = float(2).mul(
            quaternion.w.mul(quaternion.y).sub(quaternion.z.mul(quaternion.x)),
          ).clamp(-1, 1);
          particle.rotation.assign(vec3(
            atan(
              float(2).mul(quaternion.w.mul(quaternion.x).add(quaternion.y.mul(quaternion.z))),
              float(1).sub(float(2).mul(quaternion.x.mul(quaternion.x).add(quaternion.y.mul(quaternion.y)))),
            ),
            asin(sinPitch),
            atan(
              float(2).mul(quaternion.w.mul(quaternion.z).add(quaternion.x.mul(quaternion.y))),
              float(1).sub(float(2).mul(quaternion.y.mul(quaternion.y).add(quaternion.z.mul(quaternion.z)))),
            ),
          ));
        });
      },
    });
  }
}

export default OrientToDirection;
