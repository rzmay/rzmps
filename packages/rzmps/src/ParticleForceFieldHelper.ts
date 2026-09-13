import * as THREE from 'three';
import ParticleForceField from './ParticleForceField';

class ParticleForceFieldHelper extends THREE.Object3D {
  forceField: ParticleForceField;

  color: THREE.Color;

  private shapeHelper?: THREE.LineSegments;

  private directionHelper?: THREE.ArrowHelper;

  private sourceGeometry?: THREE.BufferGeometry;

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

    /*
     * Rebuild the directional arrow.
     *
     * We can only show a meaningful static arrow when direction is
     * actually a Vector3. Functional/curve-based DynamicValues don't
     * have one universal direction to visualize.
     */
    this._disposeDirection();

    if (this.forceField.direction instanceof THREE.Vector3) {
      const direction = this.forceField.direction.clone();
      const length = direction.length();

      if (length > 0) {
        direction.normalize();

        this.directionHelper = new THREE.ArrowHelper(
          direction,
          new THREE.Vector3(),
          Math.min(length, 2),
          this.color,
        );

        /*
         * Keep the arrow readable even when the force itself is very
         * weak or very strong.
         */
        this.directionHelper.setLength(
          Math.min(Math.max(length, 0.5), 2),
          0.35,
          0.2,
        );

        this.add(this.directionHelper);
      }
    }

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

    this.directionHelper?.setColor(this.color);
  }

  dispose(): void {
    this._disposeShape();
    this._disposeDirection();

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

  private _disposeDirection(): void {
    if (!this.directionHelper) return;

    this.directionHelper.removeFromParent();
    this.directionHelper.dispose();

    this.directionHelper = undefined;
  }

  onBeforeRender(): void {
    this._updateTransform();
  }
}

export default ParticleForceFieldHelper;
