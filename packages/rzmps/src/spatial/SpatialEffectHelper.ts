import * as THREE from 'three';
import SpatialEffect from '../SpatialEffect';

class SpatialEffectHelper extends THREE.Object3D {
  spatialEffect: SpatialEffect;
  color: THREE.Color;

  protected shapeHelper?: THREE.LineSegments;
  protected featherHelper?: THREE.LineSegments;
  protected sourceGeometry?: THREE.BufferGeometry;
  protected sourceFeather?: number;

  constructor(
    spatialEffect: SpatialEffect,
    color: THREE.ColorRepresentation = 0x66d9ff,
  ) {
    super();

    this.spatialEffect = spatialEffect;
    this.color = new THREE.Color(color);
    this.name = `${spatialEffect.name || 'SpatialEffect'}Helper`;

    this.updateShape();
    this.updateTransform();
  }

  update(): void {
    this.updateShape();
    this.updateTransform();
  }

  setColor(color: THREE.ColorRepresentation): void {
    this.color.set(color);

    if (this.shapeHelper?.material instanceof THREE.LineBasicMaterial) {
      this.shapeHelper.material.color.copy(this.color);
    }

    if (this.featherHelper?.material instanceof THREE.LineBasicMaterial) {
      this.featherHelper.material.color.copy(this.color);
    }
  }

  dispose(): void {
    this.disposeShape();
    this.sourceGeometry = undefined;
  }

  protected updateTransform(): void {
    this.spatialEffect.updateWorldMatrix(true, false);
    this.spatialEffect.getWorldPosition(this.position);
    this.spatialEffect.getWorldQuaternion(this.quaternion);
    this.spatialEffect.getWorldScale(this.scale);
  }

  protected updateShape(): void {
    if (!this.spatialEffect.geometry) {
      this.disposeShape();
      this.sourceGeometry = undefined;
      return;
    }

    if (
      this.shapeHelper
      && this.sourceGeometry === this.spatialEffect.geometry
      && this.sourceFeather === this.spatialEffect.feather
    ) return;

    this.disposeShape();

    const material = new THREE.LineBasicMaterial({
      color: this.color,
      transparent: true,
      opacity: 0.5,
      depthTest: false,
      toneMapped: false,
    });

    this.shapeHelper = new THREE.LineSegments(
      new THREE.WireframeGeometry(this.spatialEffect.geometry),
      material,
    );
    this.shapeHelper.renderOrder = 999;
    this.add(this.shapeHelper);

    if (this.spatialEffect.feather > 0 && this.spatialEffect.geometry.boundingBox) {
      const featherMaterial = new THREE.LineBasicMaterial({
        color: this.color,
        transparent: true,
        opacity: 0.14,
        depthTest: false,
        toneMapped: false,
      });
      const expandedGeometry = this.createFeatherGeometry(this.spatialEffect.geometry, this.spatialEffect.feather);
      const featherGeometry = new THREE.WireframeGeometry(expandedGeometry);
      expandedGeometry.dispose();

      this.featherHelper = new THREE.LineSegments(featherGeometry, featherMaterial);
      this.featherHelper.renderOrder = 998;
      this.add(this.featherHelper);
    }

    this.sourceGeometry = this.spatialEffect.geometry;
    this.sourceFeather = this.spatialEffect.feather;
  }

  protected disposeShape(): void {
    if (this.shapeHelper) {
      this.shapeHelper.removeFromParent();
      this.shapeHelper.geometry.dispose();

      if (Array.isArray(this.shapeHelper.material)) {
        this.shapeHelper.material.forEach((material) => material.dispose());
      } else {
        this.shapeHelper.material.dispose();
      }

      this.shapeHelper = undefined;
    }

    if (!this.featherHelper) {
      this.sourceFeather = undefined;
      return;
    }

    this.featherHelper.removeFromParent();
    this.featherHelper.geometry.dispose();
    if (Array.isArray(this.featherHelper.material)) {
      this.featherHelper.material.forEach((material) => material.dispose());
    } else {
      this.featherHelper.material.dispose();
    }

    this.featherHelper = undefined;
    this.sourceFeather = undefined;
  }

  protected createFeatherGeometry(
    geometry: THREE.BufferGeometry,
    feather: number,
  ): THREE.BufferGeometry {
    const expanded = geometry.clone();

    if (!expanded.getAttribute('normal')) {
      expanded.computeVertexNormals();
    }

    const position = expanded.getAttribute('position');
    const normal = expanded.getAttribute('normal');

    if (!position || !normal) return expanded;

    for (let i = 0; i < position.count; i += 1) {
      position.setXYZ(
        i,
        position.getX(i) + normal.getX(i) * feather,
        position.getY(i) + normal.getY(i) * feather,
        position.getZ(i) + normal.getZ(i) * feather,
      );
    }

    position.needsUpdate = true;
    expanded.computeBoundingBox();
    expanded.computeBoundingSphere();

    return expanded;
  }

  updateMatrixWorld(force?: boolean): void {
    this.updateTransform();
    super.updateMatrixWorld(force);
  }
}

export default SpatialEffectHelper;
