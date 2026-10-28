import * as THREE from 'three';

/** Shared logical brick/cell layout; subclasses own their data and GPU build pipelines. */
export default abstract class SpatialGrid {
  abstract readonly bounds: THREE.Box3;
  protected _brickSubdivisions = 3;
  protected _cellSubdivisions = 4;

  get brickSubdivisions(): number { return this._brickSubdivisions; }
  set brickSubdivisions(value: number) {
    const next = clampDepth(value);
    if (next === this._brickSubdivisions) return;
    this._brickSubdivisions = next;
    this.invalidateStructure();
  }

  get cellSubdivisions(): number { return this._cellSubdivisions; }
  set cellSubdivisions(value: number) {
    const next = clampDepth(value);
    if (next === this._cellSubdivisions) return;
    this._cellSubdivisions = next;
    this.invalidateStructure();
  }

  get maxDepth(): number { return this.brickSubdivisions + this.cellSubdivisions; }
  get cellsPerAxis(): number { return 2 ** this.maxDepth; }

  protected abstract invalidateStructure(): void;

  locate(position: THREE.Vector3): THREE.Vector3 {
    return SpatialGrid.locate(position, this.bounds, this.cellsPerAxis);
  }

  static locate(position: THREE.Vector3, bounds: THREE.Box3, cellsPerAxis: number): THREE.Vector3 {
    const size = bounds.getSize(new THREE.Vector3());
    return new THREE.Vector3(
      Math.floor((position.x - bounds.min.x) / Math.max(size.x, Number.EPSILON) * cellsPerAxis),
      Math.floor((position.y - bounds.min.y) / Math.max(size.y, Number.EPSILON) * cellsPerAxis),
      Math.floor((position.z - bounds.min.z) / Math.max(size.z, Number.EPSILON) * cellsPerAxis),
    ).clampScalar(0, cellsPerAxis - 1);
  }

  static normalizeBounds(
    bounds: THREE.Box3,
    powerOfTwo: boolean,
    cubic = false,
    centeredAtOrigin = false,
  ): THREE.Box3 {
    const result = bounds.clone();
    if (!powerOfTwo && !cubic && !centeredAtOrigin) return result;
    const center = centeredAtOrigin
      ? new THREE.Vector3()
      : result.getCenter(new THREE.Vector3());
    const size = centeredAtOrigin
      ? new THREE.Vector3(
        2 * Math.max(Math.abs(result.min.x), Math.abs(result.max.x)),
        2 * Math.max(Math.abs(result.min.y), Math.abs(result.max.y)),
        2 * Math.max(Math.abs(result.min.z), Math.abs(result.max.z)),
      )
      : result.getSize(new THREE.Vector3());
    if (cubic) size.setScalar(Math.max(size.x, size.y, size.z));
    if (!powerOfTwo) return result.setFromCenterAndSize(center, size);
    size.set(
      nextBoundsPowerOfTwo(size.x),
      nextBoundsPowerOfTwo(size.y),
      nextBoundsPowerOfTwo(size.z),
    );
    return result.setFromCenterAndSize(center, size);
  }
}

function clampDepth(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError('Grid subdivisions must be finite.');
  return THREE.MathUtils.clamp(Math.floor(value), 0, 10);
}
function nextBoundsPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(value, Number.EPSILON)) - 1e-6);
}
