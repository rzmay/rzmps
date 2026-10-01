import * as THREE from 'three';
import BoidAffector from './BoidAffector';

class BoidAffectorHelper extends THREE.Object3D {
  affector: BoidAffector;
  color: THREE.Color;

  private shapeHelper?: THREE.LineSegments;
  private sampleArrows: THREE.ArrowHelper[] = [];
  private sourceGeometry?: THREE.BufferGeometry;
  private sampleBounds = new THREE.Box3();
  private sampleBoundsSize = new THREE.Vector3();
  private sampleLocalPosition = new THREE.Vector3();
  private sampleWorldPosition = new THREE.Vector3();
  private sampleInfluence = new THREE.Vector3();
  private inverseWorldQuaternion = new THREE.Quaternion();

  constructor(
    affector: BoidAffector,
    color: THREE.ColorRepresentation = 0x66d9ff,
  ) {
    super();

    this.affector = affector;
    this.color = new THREE.Color(color);
    this.name = `${affector.name || 'BoidAffector'}Helper`;

    this.update();
  }

  update(): void {
    if (!this.shapeHelper || this.sourceGeometry !== this.affector.geometry) {
      this._disposeShape();

      if (this.affector.geometry) {
        const material = new THREE.LineBasicMaterial({
          color: this.color,
          transparent: true,
          opacity: 0.65,
          depthTest: false,
          toneMapped: false,
        });

        this.shapeHelper = new THREE.LineSegments(
          new THREE.WireframeGeometry(this.affector.geometry),
          material,
        );
        this.shapeHelper.renderOrder = 999;
        this.add(this.shapeHelper);
      }

      this.sourceGeometry = this.affector.geometry;
    }

    this._disposeSampleArrows();
    this._buildSampleArrows();
    this._updateTransform();
  }

  setColor(color: THREE.ColorRepresentation): void {
    this.color.set(color);

    if (this.shapeHelper?.material instanceof THREE.LineBasicMaterial) {
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
    this.affector.updateWorldMatrix(true, false);
    this.affector.getWorldPosition(this.position);
    this.affector.getWorldQuaternion(this.quaternion);
    this.affector.getWorldScale(this.scale);
  }

  private _buildSampleArrows(): void {
    if (!this.affector.geometry) return;
    if (!this.affector.geometry.boundingBox) {
      this.affector.geometry.computeBoundingBox();
    }

    const bounds = this.affector.geometry.boundingBox;
    if (!bounds) return;

    this.affector.updateWorldMatrix(true, false);
    this.affector.getWorldQuaternion(this.inverseWorldQuaternion).invert();

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
          this.affector.localToWorld(this.sampleWorldPosition);
          this.affector.getInfluenceDirection(this.sampleWorldPosition, this.sampleInfluence);

          if (this.sampleInfluence.lengthSq() <= Number.EPSILON) continue;

          this.sampleInfluence
            .normalize()
            .multiplyScalar(-Math.sign(this.affector.weight || 1))
            .applyQuaternion(this.inverseWorldQuaternion);

          const length = THREE.MathUtils.clamp(Math.abs(this.affector.weight) * 0.25, 0.25, 1.25);
          const arrow = new THREE.ArrowHelper(
            this.sampleInfluence,
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

  private _disposeShape(): void {
    if (!this.shapeHelper) return;

    this.shapeHelper.removeFromParent();
    this.shapeHelper.geometry.dispose();

    if (Array.isArray(this.shapeHelper.material)) {
      this.shapeHelper.material.forEach((material) => material.dispose());
    } else {
      this.shapeHelper.material.dispose();
    }

    this.shapeHelper = undefined;
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

export default BoidAffectorHelper;
