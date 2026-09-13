import * as THREE from 'three';
import Particle from './Particle';
import { IParticleForceField } from './interfaces/IParticleForceField';
import { DynamicValue } from './types/DynamicValue';
import evaluateDynamicNumber from './helpers/evaluateDynamicNumber';
import evaluateDynamicVector from './helpers/evaluateDynamicVector3';
import isPointInMesh from './helpers/isPointInMesh';
import { StrictMultiple } from './types/Multiple';
import { Tag } from './types/Tag';
import acceptMultiple from './helpers/acceptMultiple';
import tagsIntersect from './helpers/tagsIntersect';

export interface ForceFieldOptions {
    position: THREE.Vector3;
    direction: DynamicValue<THREE.Vector3>;
    gravity: DynamicValue<number>;
    rotationSpeed: DynamicValue<number>;
    rotationAttraction: DynamicValue<number>;
    drag: DynamicValue<number>;
    scale: THREE.Vector3;
    geometry: THREE.BufferGeometry;
    tags: StrictMultiple<Tag>;
}

class ParticleForceField extends THREE.Object3D implements IParticleForceField {
  private static readonly _doubleSidedMaterial = new THREE.MeshBasicMaterial(
    { side: THREE.DoubleSide },
  );

  static Box(options?: Partial<ForceFieldOptions>, ...args: any[]): ParticleForceField {
    return new ParticleForceField({ ...options, geometry: new THREE.BoxGeometry(...args) });
  }

  static Sphere(options?: Partial<ForceFieldOptions>, ...args: any[]): ParticleForceField {
    return new ParticleForceField({ ...options, geometry: new THREE.SphereGeometry(...args) });
  }

  static Cone(options?: Partial<ForceFieldOptions>, ...args: any[]): ParticleForceField {
    return new ParticleForceField({ ...options, geometry: new THREE.ConeGeometry(...args) });
  }

  static Torus(options?: Partial<ForceFieldOptions>, ...args: any[]): ParticleForceField {
    return new ParticleForceField({ ...options, geometry: new THREE.TorusGeometry(...args) });
  }

  direction?: DynamicValue<THREE.Vector3>;
  gravity?: DynamicValue<number>;

  rotationSpeed?: DynamicValue<number>;
  rotationAttraction?: DynamicValue<number>;

  drag?: DynamicValue<number>;

  tags?: Tag[];

  private _geometry: THREE.BufferGeometry;
  set geometry(value: THREE.BufferGeometry) {
    this._geometry = value;

    this._geometry.computeBoundingBox();

    this._mesh.geometry = value;
  }
  get geometry(): THREE.BufferGeometry {
    return this._geometry;
  }

  private _mesh: THREE.Mesh;

  constructor(options: Partial<ForceFieldOptions>) {
    super();

    if (options.position) {
      this.position.copy(options.position);
    }

    if (options.scale) {
      this.scale.copy(options.scale);
    }

    this.direction = options.direction;
    this.gravity = options.gravity;
    this.rotationSpeed = options.rotationSpeed;
    this.rotationAttraction = options.rotationAttraction;
    this.drag = options.drag;

    this.tags = acceptMultiple(options.tags);

    this._geometry = options.geometry ?? new THREE.SphereGeometry();

    this._geometry.computeBoundingBox();

    this._mesh = new THREE.Mesh(
      this._geometry,
      ParticleForceField._doubleSidedMaterial,
    );
  }

  getForce(particle: Particle): THREE.Vector3 {
    this.updateWorldMatrix(true, false);

    if (
      !this.contains(particle.position)
      || (this.tags && !tagsIntersect(this.tags, particle.tags ?? []))
    ) return new THREE.Vector3();

    const { time } = particle;
    const force = new THREE.Vector3();
    const center = new THREE.Vector3();
    this.getWorldPosition(center);
    const toCenter = center.clone().sub(particle.position);
    const distanceSq = toCenter.lengthSq();

    if (this.direction !== undefined) {
      const direction = evaluateDynamicVector(
        this.direction,
        time,
      ).clone();

      const rotation = this.getWorldQuaternion(
        new THREE.Quaternion(),
      );

      direction.applyQuaternion(rotation);

      force.add(direction);
    }

    if (this.gravity !== undefined && distanceSq > 0) {
      force.add(toCenter.clone().normalize().multiplyScalar(evaluateDynamicNumber(this.gravity, time)));
    }

    if (this.rotationSpeed !== undefined && distanceSq > 0) {
      const rotationAxis = new THREE.Vector3(0, 1, 0)
        .applyQuaternion(
          this.getWorldQuaternion(new THREE.Quaternion()),
        );

      const fromCenter = particle.position.clone().sub(center);
      const tangent = rotationAxis.cross(fromCenter).normalize();

      force.add(tangent.multiplyScalar(evaluateDynamicNumber(this.rotationSpeed, time)));
    }

    if (this.rotationAttraction !== undefined && distanceSq > 0) {
      force.add(toCenter.clone().normalize().multiplyScalar(
        evaluateDynamicNumber(this.rotationAttraction, time),
      ));
    }

    if (this.drag !== undefined) {
      force.addScaledVector(particle.velocity, -evaluateDynamicNumber(this.drag, time));
    }

    return force.multiplyScalar(this.getFalloff(particle.position));
  }

  private contains(position: THREE.Vector3): boolean {
    const localPosition = this.worldToLocal(position.clone());

    return isPointInMesh(localPosition, this._mesh);
  }

  private getFalloff(position: THREE.Vector3): number {
    const localPosition = this.worldToLocal(position.clone());

    if (!this._geometry.boundingBox) {
      this._geometry.computeBoundingBox();
    }

    const size = new THREE.Vector3();

    this._geometry.boundingBox!.getSize(size);

    const radius = size.length() * 0.5;

    if (radius <= 0) return 0;

    return 1 - Math.min(
      localPosition.length() / radius,
      1,
    );
  }
}

export default ParticleForceField;
