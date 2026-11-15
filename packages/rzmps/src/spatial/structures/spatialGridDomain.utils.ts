import * as THREE from 'three';
import acceptVector3 from '../../values/acceptVector3';

/** Explicit depths or world-space travel; travel is converted in the selected quality lattice. */
export type SpatialGuardDepth = readonly number[] | { travel: readonly number[] };

export interface SpatialDomainOptions {
  minBounds?: number | THREE.Vector3;
  maxBounds?: number | THREE.Vector3;
  minVolumeQuality?: number;
  maxVolumeQuality?: number;
  powerOfTwoBounds?: boolean;
  cubicBounds?: boolean;
  centeredAtOrigin?: boolean;
}

export interface SpatialGridDomain {
  target: THREE.Box3;
  bounds: THREE.Box3;
  gridDimensions: THREE.Vector3;
  brickDimensions: THREE.Vector3;
  cellSize: number;
  brickSize: number;
  equivalentVolumeSide: number;
  qualitySide: number;
  hardCapBreach: boolean;
}

export function boundsVector(value: number | THREE.Vector3 | undefined, fallback: number): THREE.Vector3 {
  const result = acceptVector3(value ?? fallback).clone();
  if (result.toArray().some(component => Number.isNaN(component) || component < 0)) {
    throw new RangeError('Physical bounds dimensions must be nonnegative.');
  }
  return result;
}

/** Quality is derived before snapping. Cubic cells do not require a cubic world domain. */
export function createSpatialDomain(target: THREE.Box3, referenceResolution: number, cellsPerBrick: number,
  options: SpatialDomainOptions = {}, previousQuality?: number): SpatialGridDomain {
  const requested = target.isEmpty()
    ? new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)) : target;
  const minimum = boundsVector(options.minBounds, 0), maximum = boundsVector(options.maxBounds, Infinity);
  if (!minimum.toArray().every(Number.isFinite)) throw new RangeError('minBounds must be finite.');
  if (maximum.toArray().some((v, i) => !(v > 0) || v < minimum.getComponent(i))) {
    throw new RangeError('maxBounds must be positive and no smaller than minBounds on every axis.');
  }
  const center = options.centeredAtOrigin ? new THREE.Vector3() : requested.getCenter(new THREE.Vector3());
  const size = options.centeredAtOrigin
    ? new THREE.Vector3(...(['x', 'y', 'z'] as const).map(axis =>
      2 * Math.max(Math.abs(requested.min[axis]), Math.abs(requested.max[axis]))))
    : requested.getSize(new THREE.Vector3());
  const hardCapBreach = size.toArray().some((value, i) => value > maximum.getComponent(i) + 1e-6);
  size.max(minimum).min(maximum).max(new THREE.Vector3().setScalar(1e-6));
  if (options.cubicBounds) {
    size.setScalar(Math.min(Math.max(size.x, size.y, size.z), maximum.x, maximum.y, maximum.z));
  }
  const equivalentVolumeSide = Math.cbrt(size.x * size.y * size.z);
  const minQuality = options.minVolumeQuality ?? 2, maxQuality = options.maxVolumeQuality ?? Infinity;
  if (!(minQuality > 0) || !Number.isFinite(minQuality) || maxQuality < minQuality || Number.isNaN(maxQuality)) {
    throw new RangeError('Volume quality limits must be positive and increasing.');
  }
  // Bound implicit linear refinement by the enclosing-cube reference scale. Rectangular coverage
  // saves empty bricks without increasing samples along the longest axis as aspect ratio grows.
  // Explicit quality limits (including a fixed volumeQuality) remain authoritative.
  const referenceSide = Math.max(equivalentVolumeSide, size.x, size.y, size.z);
  const metric = THREE.MathUtils.clamp(referenceSide, minQuality, maxQuality);
  const powerOfTwo = options.powerOfTwoBounds !== false;
  const minimumTier = powerOfTwo ? 2 ** Math.ceil(Math.log2(minQuality) - 1e-6) : minQuality;
  const maximumTier = powerOfTwo ? 2 ** Math.floor(Math.log2(maxQuality) + 1e-6) : maxQuality;
  if (minimumTier > maximumTier) throw new RangeError('Volume quality interval contains no valid quality tier.');
  let qualitySide = powerOfTwo ? 2 ** Math.ceil(Math.log2(metric) - 1e-6) : metric;
  // Bounds coverage is independent: keep the current tier through a bounded 10% crossing
  // in either direction, rather than letting domain growth force an immediate quality change.
  if (previousQuality && powerOfTwo && previousQuality >= minimumTier && previousQuality <= maximumTier
    && metric <= previousQuality * 1.1 && metric > previousQuality * 0.45) qualitySide = previousQuality;
  qualitySide = THREE.MathUtils.clamp(qualitySide, minimumTier, maximumTier);
  const cellSize = qualitySide / referenceResolution, brickSize = cellSize * cellsPerBrick;
  const bounds = new THREE.Box3().setFromCenterAndSize(center, size);
  const bricks = new THREE.Vector3();
  for (const axis of ['x', 'y', 'z'] as const) {
    const maximumBricks = Math.floor(maximum[axis] / brickSize + 1e-6);
    const minimumBricks = Math.max(1, Math.ceil(minimum[axis] / brickSize - 1e-6));
    if (maximumBricks < minimumBricks) {
      throw new RangeError('Physical bounds limits cannot fit a whole brick at the selected volume quality.');
    }
    let low = Math.floor(bounds.min[axis] / brickSize);
    let high = Math.ceil(bounds.max[axis] / brickSize);
    const count = Math.min(maximumBricks, Math.max(minimumBricks, high - low));
    if (count !== high - low) low = Math.floor(center[axis] / brickSize - count / 2);
    high = low + count;
    bounds.min[axis] = low * brickSize; bounds.max[axis] = high * brickSize;
    bricks[axis] = count;
  }
  return { target: requested.clone(), bounds, brickDimensions: bricks,
    gridDimensions: bricks.clone().multiplyScalar(cellsPerBrick),
    cellSize, brickSize, equivalentVolumeSide, qualitySide, hardCapBreach };
}

/** Occupancy alone chooses quality; final guards never feed snapped allocation back into that choice. */
export function createGuardedSpatialDomain(occupied: THREE.Box3, referenceResolution: number, cellsPerBrick: number,
  options: SpatialDomainOptions, previousQuality?: number, guardBricks?: SpatialGuardDepth): SpatialGridDomain {
  const nominal = createSpatialDomain(occupied, referenceResolution, cellsPerBrick, options);
  const required = occupied.clone();
  for (let face = 0; face < 6; face++) {
    const axis = (['x', 'y', 'z'] as const)[Math.floor(face / 2)];
    const travel = guardBricks && 'travel' in guardBricks ? guardBricks.travel[face] ?? 0 : 0;
    const padding = Math.max(nominal.brickSize, travel);
    if (!Number.isFinite(padding)) throw new RangeError('Guard travel must be finite.');
    required[face % 2 ? 'max' : 'min'][axis] += (face % 2 ? 1 : -1) * padding;
  }
  const quality = createSpatialDomain(required, referenceResolution, cellsPerBrick, options, previousQuality);
  // Rebuild the guard in the selected lattice without another quality decision.
  const guarded = occupied.clone();
  for (let face = 0; face < 6; face++) {
    const axis = (['x', 'y', 'z'] as const)[Math.floor(face / 2)];
    const requested = guardBricks && 'travel' in guardBricks
      ? (guardBricks.travel[face] ?? 0) / quality.brickSize : guardBricks?.[face] ?? 1;
    const depth = Math.max(1, Math.ceil(requested));
    if (!Number.isFinite(depth)) throw new RangeError('Guard depth must be finite.');
    guarded[face % 2 ? 'max' : 'min'][axis] += (face % 2 ? 1 : -1) * depth * quality.brickSize;
  }
  const domain = createSpatialDomain(guarded, referenceResolution, cellsPerBrick,
    { ...options, minBounds: options.minBounds, maxBounds: options.maxBounds,
      minVolumeQuality: quality.qualitySide, maxVolumeQuality: quality.qualitySide });
  domain.hardCapBreach ||= nominal.hardCapBreach || quality.hardCapBreach;
  domain.target.copy(required);
  domain.equivalentVolumeSide = quality.equivalentVolumeSide;
  return domain;
}
