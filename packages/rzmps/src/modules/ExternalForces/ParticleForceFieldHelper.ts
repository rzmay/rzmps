import * as THREE from 'three';
import Particle from '../../Particle';
import ParticleForceField from './ParticleForceField';

class ParticleForceFieldHelper extends THREE.Object3D {
  forceField: ParticleForceField;

  color: THREE.Color;

  private shapeHelper?: THREE.LineSegments;

  private sampleArrows: THREE.ArrowHelper[] = [];

  private sourceGeometry?: THREE.BufferGeometry;
  private sampleParticle = new Particle({ lifetime: 1 });
  private sampleLocalPosition = new THREE.Vector3();
  private sampleWorldPosition = new THREE.Vector3();
  private sampleForce = new THREE.Vector3();
  private sampleBounds = new THREE.Box3();
  private sampleBoundsSize = new THREE.Vector3();
  private inverseWorldQuaternion = new THREE.Quaternion();

  constructor(
    forceField: ParticleForceField,
    color: THREE.ColorRepresentation = 0xffff00,
  ) {
    super();

    this.forceField = forceField;
    this.color = new THREE.Color(color);

    this.name = `${forceField.name || 'ParticleForceField'}Helper`;

    this.update();
  }

  update(): void {
    /*
     * Only rebuild the shape geometry if the force field geometry
     * itself changed.
     */
    if (
      !this.shapeHelper
      || this.sourceGeometry !== this.forceField.geometry
    ) {
      this._disposeShape();

      const material = new THREE.LineBasicMaterial({
        color: this.color,
        transparent: true,
        opacity: 0.5,
        depthTest: false,
        toneMapped: false,
      });

      const geometry = new THREE.WireframeGeometry(
        this.forceField.geometry,
      );

      this.shapeHelper = new THREE.LineSegments(
        geometry,
        material,
      );

      this.shapeHelper.renderOrder = 999;

      this.add(this.shapeHelper);

      this.sourceGeometry = this.forceField.geometry;
    }

    this._disposeSampleArrows();
    this._buildSampleArrows();
    this._updateTransform();
  }

  setColor(color: THREE.ColorRepresentation): void {
    this.color.set(color);

    if (
      this.shapeHelper?.material
      instanceof THREE.LineBasicMaterial
    ) {
      this.shapeHelper.material.color.copy(this.color);
    }

    this.sampleArrows.forEach((arrow) => arrow.setColor(this.color));
  }

  dispose(): void {
    this._disposeShape();
    this._disposeSampleArrows();

    this.sourceGeometry = undefined;
  }

  private _updateTransform(): void {
    this.forceField.updateWorldMatrix(true, false);

    this.forceField.getWorldPosition(this.position);
    this.forceField.getWorldQuaternion(this.quaternion);
    this.forceField.getWorldScale(this.scale);
  }

  private _disposeShape(): void {
    if (!this.shapeHelper) return;

    this.shapeHelper.removeFromParent();

    /*
     * This is a WireframeGeometry owned by the helper, so disposing it
     * does NOT dispose the ParticleForceField's actual geometry.
     */
    this.shapeHelper.geometry.dispose();

    if (Array.isArray(this.shapeHelper.material)) {
      this.shapeHelper.material.forEach(
        material => material.dispose(),
      );
    }
    else {
      this.shapeHelper.material.dispose();
    }

    this.shapeHelper = undefined;
  }

  private _buildSampleArrows(): void {
    this.forceField.updateWorldMatrix(true, false);
    this.forceField.getWorldQuaternion(this.inverseWorldQuaternion).invert();

    if (!this.forceField.geometry.boundingBox) {
      this.forceField.geometry.computeBoundingBox();
    }

    const bounds = this.forceField.geometry.boundingBox;
    if (!bounds) return;

    this.sampleBounds.copy(bounds);
    bounds.getCenter(this.sampleWorldPosition);
    bounds.getSize(this.sampleBoundsSize).multiplyScalar(0.5);
    this.sampleBounds.setFromCenterAndSize(this.sampleWorldPosition, this.sampleBoundsSize);

    for (let x = 0; x < 3; x += 1) {
      for (let y = 0; y < 3; y += 1) {
        for (let z = 0; z < 3; z += 1) {
          this.sampleLocalPosition.set(
            THREE.MathUtils.lerp(this.sampleBounds.min.x, this.sampleBounds.max.x, x / 2),
            THREE.MathUtils.lerp(this.sampleBounds.min.y, this.sampleBounds.max.y, y / 2),
            THREE.MathUtils.lerp(this.sampleBounds.min.z, this.sampleBounds.max.z, z / 2),
          );

          this.sampleWorldPosition.copy(this.sampleLocalPosition);
          this.forceField.localToWorld(this.sampleWorldPosition);
          this.sampleParticle.position.copy(this.sampleWorldPosition);
          this.sampleParticle.velocity.set(0, 0, 0);
          this.sampleParticle.time = 0;
          this.sampleForce.copy(this.forceField.getForce(this.sampleParticle));

          if (this.sampleForce.lengthSq() <= Number.EPSILON) continue;

          const length = THREE.MathUtils.clamp(this.sampleForce.length() * 0.35, 0.25, 1.25);
          this.sampleForce.normalize().applyQuaternion(this.inverseWorldQuaternion);

          const arrow = new THREE.ArrowHelper(
            this.sampleForce,
            this.sampleLocalPosition.clone(),
            length,
            this.color,
            length * 0.35,
            length * 0.18,
          );

          arrow.renderOrder = 1000;
          this.sampleArrows.push(arrow);
          this.add(arrow);
        }
      }
    }
  }

  private _disposeSampleArrows(): void {
    this.sampleArrows.forEach((arrow) => {
      arrow.removeFromParent();
      arrow.dispose();
    });

    this.sampleArrows = [];
  }

  onBeforeRender(): void {
    this._updateTransform();
  }
}

export default ParticleForceFieldHelper;
