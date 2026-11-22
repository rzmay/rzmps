import * as THREE from 'three';
import type Particle from '../../core/Particle';
import type ParticleSystem from '../../core/ParticleSystem';

/** Projector-space footprint deformation. Skew components are shear coefficients; angles are radians. */
export interface DecalWarp {
  scale?: THREE.Vector2;
  rotation?: number;
  skew?: THREE.Vector2;
  perspective?: THREE.Vector2;
}

export type DecalWarpSampler = ((particle: Particle, ray: THREE.Ray, hit: THREE.Intersection) => DecalWarp) & {
  /** Optional compact GPU metadata preparation for CPU placement samplers. */
  prepareReadback?: (particles: Particle[], system: ParticleSystem) => Promise<void>;
};
export type DecalWarpInput = DecalWarp | DecalWarpSampler;
const composed = new WeakMap<DecalWarp, THREE.Matrix3>();
const placementFrames = new WeakMap<Particle, THREE.Matrix4>();

/** Forward map on centered unit UVs. Combined warps retain their exact matrix rather than decomposing it. */
export function decalWarpMatrix(warp: DecalWarp): THREE.Matrix3 {
  const stored = composed.get(warp);
  if (stored) return stored.clone();
  const scale = warp.scale ?? new THREE.Vector2(1, 1),
    skew = warp.skew ?? new THREE.Vector2();
  const perspective = warp.perspective ?? new THREE.Vector2(),
    angle = warp.rotation ?? 0;
  const c = Math.cos(angle),
    s = Math.sin(angle);
  return new THREE.Matrix3()
    .set(c, -s, 0, s, c, 0, 0, 0, 1)
    .multiply(new THREE.Matrix3().set(1, skew.x, 0, skew.y, 1, 0, 0, 0, 1))
    .multiply(new THREE.Matrix3().set(scale.x, 0, 0, 0, scale.y, 0, 0, 0, 1))
    .multiply(new THREE.Matrix3().set(1, 0, 0, 0, 1, 0, perspective.x, perspective.y, 1));
}

export function sampleDecalWarp(
  warp: DecalWarpInput | undefined,
  particle: Particle,
  ray: THREE.Ray,
  hit: THREE.Intersection,
  system?: ParticleSystem,
): THREE.Matrix3 {
  const previous = placementFrames.get(particle);
  if (system) placementFrames.set(particle, system.getSimulationToWorldMatrix());
  try {
    return decalWarpMatrix(typeof warp === 'function' ? warp(particle, ray, hit) : (warp ?? {}));
  } finally {
    if (system) {
      if (previous) placementFrames.set(particle, previous);
      else placementFrames.delete(particle);
    }
  }
}

/** Bound the actual transformed square. Poles/singular transforms safely reject placement. */
export function decalWarpBounds(matrix: THREE.Matrix3): THREE.Box2 | undefined {
  if (!matrix.elements.every(Number.isFinite) || Math.abs(matrix.determinant()) < 1e-8) return;
  const bounds = new THREE.Box2(),
    denominator = [];
  for (const x of [-0.5, 0.5])
    for (const y of [-0.5, 0.5]) {
      const p = new THREE.Vector3(x, y, 1).applyMatrix3(matrix);
      denominator.push(p.z);
      if (Math.abs(p.z) < 1e-5) return;
      bounds.expandByPoint(new THREE.Vector2(p.x / p.z, p.y / p.z));
    }
  if (Math.min(...denominator) < 0 && Math.max(...denominator) > 0) return;
  if (!bounds.min.toArray().concat(bounds.max.toArray()).every(Number.isFinite)) return;
  return bounds;
}

/** Normal in world space, matching DecalGeometry's projector orientation convention. */
export function decalHitNormal(hit: THREE.Intersection): THREE.Vector3 {
  const normal = (hit.normal ?? hit.face?.normal ?? new THREE.Vector3(0, 0, 1)).clone();
  if (hit.face && normal.dot(hit.face.normal) < 0) normal.negate();
  return normal.applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
}

/** Stretch the tangent footprint using either ray incidence or world-space tangential speed. */
function incidenceWarp(
  particle: Particle,
  direction: THREE.Vector3,
  hit: THREE.Intersection,
  maxStretch: number,
  velocityFactor?: number,
): DecalWarp {
  if (!direction.toArray().every(Number.isFinite) || direction.lengthSq() < 1e-12) return {};
  const incoming = direction.clone();
  const normal = decalHitNormal(hit),
    incidence = Math.abs(normal.dot(incoming)) / incoming.length();
  const orientation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
  orientation.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), particle.rotation.z));
  const projected = incoming.clone().applyQuaternion(orientation.invert());
  const length = Math.hypot(projected.x, projected.y);
  if (length < 1e-6) return {};
  const x = projected.x / length,
    y = projected.y / length;
  const scale = Math.min(
    maxStretch,
    velocityFactor === undefined ? 1 / Math.max(1e-6, incidence) : 1 + velocityFactor * length,
  );

  // Ray projection stays symmetric. Velocity splats keep the rear extent and extend forward instead.
  // The square's support radius bounds the denominator even for diagonal motion at the stretch cap.
  const support = (Math.abs(x) + Math.abs(y)) / 2;
  const perspective = velocityFactor === undefined ? 0 : (scale - 1) / (scale * support);
  const stretch = velocityFactor === undefined ? scale - 1 : 1 - 1 / scale;
  const result = {};
  composed.set(
    result,
    new THREE.Matrix3().set(
      1 + stretch * x * x,
      stretch * x * y,
      0,
      stretch * x * y,
      1 + stretch * y * y,
      0,
      -perspective * x,
      -perspective * y,
      1,
    ),
  );
  return result;
}

export const decalWarps = {
  Scale: (scale: THREE.Vector2 | number): DecalWarp => ({
    scale: typeof scale === 'number' ? new THREE.Vector2(scale, scale) : scale.clone(),
  }),
  Rotate: (rotation: number): DecalWarp => ({ rotation }),
  Skew: (skew: THREE.Vector2): DecalWarp => ({ skew: skew.clone() }),
  Perspective: (perspective: THREE.Vector2): DecalWarp => ({ perspective: perspective.clone() }),
  /** Stretch along the placement ray. maxStretch caps the length multiplier (default 4, minimum 1). */
  FromRay(maxStretch = 4): DecalWarpSampler {
    const limit = Number.isFinite(maxStretch) ? Math.max(1, maxStretch) : 4;
    return (particle, ray, hit) => incidenceWarp(particle, ray.direction, hit, limit);
  },
  /**
   * Projectively splatter forward along world-space incoming motion, anchoring the impact and rear extent.
   * Total extent along motion scales by min(maxStretch, 1 + factor * world-space tangential speed).
   * The rear remains close to its original shape while the front stretches and flares; the footprint is off-center.
   * @param maxStretch Maximum length multiplier; defaults to 4 and is clamped to at least 1.
   * @param factor Additional stretch per world unit/second of tangential speed; defaults to 1, minimum 0.
   */
  FromVelocity(maxStretch = 4, factor = 1): DecalWarpSampler {
    const strength = Number.isFinite(factor) ? Math.max(0, factor) : 1;
    const limit = Number.isFinite(maxStretch) ? Math.max(1, maxStretch) : 4;
    return (particle, _ray, hit) => {
      const velocity = particle.velocity.clone().multiplyScalar(particle.speed);
      const frame = placementFrames.get(particle);
      if (frame) velocity.applyMatrix3(new THREE.Matrix3().setFromMatrix4(frame));
      return incidenceWarp(particle, velocity, hit, limit, strength);
    };
  },
  /** Arguments apply left to right: Combine(A, B) maps p to B * A * p. */
  Combine(...warps: readonly DecalWarpInput[]): DecalWarpSampler {
    const sampler: DecalWarpSampler = (particle, ray, hit) => {
      const matrix = new THREE.Matrix3();
      for (const warp of warps) matrix.premultiply(sampleDecalWarp(warp, particle, ray, hit));
      const result = {};
      composed.set(result, matrix);
      return result;
    };
    sampler.prepareReadback = async (particles, system) => {
      const prepare = new Set(
        warps
          .filter(warp => typeof warp === 'function')
          .map(warp => (warp as DecalWarpSampler).prepareReadback)
          .filter(Boolean),
      );
      for (const callback of prepare) await callback!(particles, system);
    };
    return sampler;
  },
};
