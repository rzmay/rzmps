import * as THREE from 'three';
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
    });
  }
}

export default OrientToDirection;
