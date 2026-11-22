import * as THREE from 'three';
import { StorageBufferAttribute, type Node } from 'three/webgpu';
import { float, floor, ivec3, storage, uniform, vec3, vec4 } from 'three/tsl';
import type SparseVolumeGrid from '../../spatial/structures/gpu/SparseVolumeGrid';
import { sparseCellIndex } from '../../spatial/structures/gpu/sparseVolumeSampling.utils';
import type ParticleSystem from '../../core/ParticleSystem';
import type { GPUParticleLike } from '../../simulation/gpu/Particle';
import type { GPUSurfaceQuery } from '../../spatial/surfaces/surfaceSample.types';
import { transformDirectionGPU, transformPointGPU } from '../../simulation/gpu/transforms.utils';

/** One trilinear stencil provides both scalar/color interpolation and its analytic outward gradient. */
export function sampleSurfaceField(coordinate: Node<'vec3'>,
  value: (coordinate: Node<'ivec3'>) => Node<'vec4'>, withGradient = true) {
  const lower = ivec3(floor(coordinate)).toVar(), fraction = coordinate.sub(vec3(lower)).toVar();
  const result = vec4(0).toVar(), gradient = vec3(0).toVar();
  for (let corner = 0; corner < 8; corner++) {
    const bits = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1];
    const weights = bits.map((bit, axis) => {
      const t = fraction[['x', 'y', 'z'][axis] as 'x' | 'y' | 'z'];
      return bit ? t : float(1).sub(t);
    });
    // Sparse addressing is shared by every weight/gradient term, not expanded for each use.
    const sample = value(lower.add(ivec3(...bits))).toVar();
    result.addAssign(sample.mul(weights[0].mul(weights[1]).mul(weights[2])));
    // Scalar is high inside liquid, so the outward normal is -grad(F).
    if (withGradient) gradient.addAssign(vec3(weights[1].mul(weights[2]).mul(bits[0] ? -1 : 1),
      weights[0].mul(weights[2]).mul(bits[1] ? -1 : 1),
      weights[0].mul(weights[1]).mul(bits[2] ? -1 : 1)).mul(sample.w));
  }
  return { value: result, outwardGradient: gradient };
}

/** Stable runtime bindings survive reconstruction pool swaps, page-table growth and reset.
 * No generated triangles/BVH or CPU field readback is involved. */
export function createLiquidSurfaceQuery() {
  const emptyField = new StorageBufferAttribute(new Float32Array(12), 4);
  const emptyPages = new StorageBufferAttribute(new Uint32Array(1), 1);
  const field = storage(emptyField, 'vec4', 0).toReadOnly();
  const pages = storage(emptyPages, 'uint', 0).toReadOnly();
  const dimensions = uniform(new THREE.Vector3(1, 1, 1)), minimum = uniform(new THREE.Vector3());
  const cellSize = uniform(1), side = uniform(1), cells = uniform(1, 'uint'), iso = uniform(0.2);
  const enabled = uniform(0), toWorld = uniform(new THREE.Matrix4()), toLocal = uniform(new THREE.Matrix4());
  const previousWorld = uniform(new THREE.Matrix4()), dt = uniform(0);
  let initialized = false;
  const index = (coordinate: Node<'ivec3'>) => sparseCellIndex(coordinate, pages, dimensions, side, cells).toVar();
  const scalar = (coordinate: Node<'ivec3'>) => field.element(index(coordinate));

  const sampleSurfaceGPU: GPUSurfaceQuery = position => {
    const local = transformPointGPU(position, toLocal).toVar();
    const coordinate = local.sub(minimum).div(cellSize).toVar();
    const sample = sampleSurfaceField(coordinate, scalar);
    const gradient = sample.outwardGradient.div(cellSize).toVar();
    const magnitude = gradient.length().toVar();
    const localNormal = gradient.div(magnitude.max(1e-8)).toVar();
    const localDistance = iso.sub(sample.value.w).div(magnitude.max(1e-8)).toVar();
    const surfacePosition = local.sub(localNormal.mul(localDistance)).toVar();
    const atSurface = surfacePosition.sub(minimum).div(cellSize);
    const flow = sampleSurfaceField(atSurface, c => {
      const address = index(c);
      return vec4(field.element(address.add(cells)).xyz, field.element(address).w);
    }, false).value;
    const density = flow.w;
    // The same reconstructed strain field drives liquid shading and foam-source selection.
    const deformation = sampleSurfaceField(atSurface,
      c => field.element(index(c).add(cells.mul(2))), false).value.w;
    const physicalVelocity = flow.xyz.div(density.max(1e-8));
    const worldPoint = transformPointGPU(surfacePosition, toWorld);
    const normalMatrix = toLocal.transpose();
    const transformedNormal = transformDirectionGPU(localNormal, normalMatrix);
    const worldNormal = transformedNormal.length().greaterThan(1e-8)
      .select(transformedNormal.div(transformedNormal.length().max(1e-8)), vec3(0, 1, 0));
    const worldDistance = position.sub(worldPoint).dot(worldNormal);
    const motion = worldPoint.sub(transformPointGPU(surfacePosition, previousWorld)).div(dt.max(1e-8));
    return { distance: worldDistance, normal: worldNormal, deformation,
      velocity: transformDirectionGPU(physicalVelocity, toWorld).add(dt.greaterThan(0).select(motion, vec3(0))),
      valid: enabled.greaterThan(0).and(coordinate.greaterThanEqual(0).all())
        .and(coordinate.lessThan(dimensions.sub(1)).all()).and(magnitude.greaterThan(1e-6))
        .and(localDistance.abs().lessThanEqual(cellSize.mul(2))).and(density.greaterThan(1e-8)) };
  };

  return {
    sampleSurfaceGPU,
    update(grid: SparseVolumeGrid, attribute: StorageBufferAttribute, level: number,
      transform = new THREE.Matrix4(), deltaTime = 0) {
      pages.value = grid.pagesAttribute; field.value = attribute;
      minimum.value.copy(grid.bounds.min); dimensions.value.copy(grid.gridDimensions);
      // LiquidSurface's lattice minimum is independent of its sparse pool's default layout metadata.
      cellSize.value = grid.cellSize; side.value = grid.brickSide; cells.value = grid.cellCount; iso.value = level;
      previousWorld.value.copy(initialized ? toWorld.value : transform);
      toWorld.value.copy(transform); toLocal.value.copy(transform).invert();
      dt.value = initialized ? deltaTime : 0; enabled.value = 1; initialized = true;
    },
    setLattice(bounds: THREE.Box3, spacing: number) {
      minimum.value.copy(bounds.min); cellSize.value = spacing;
    },
    invalidate() {
      enabled.value = 0; initialized = false;
      field.value = emptyField; pages.value = emptyPages; cells.value = 1;
      dimensions.value.set(1, 1, 1);
    },
    dispose() { enabled.value = 0; emptyField.dispose(); emptyPages.dispose(); },
  };
}

/** Shared exposed-surface/activity classification for foam and contact renderers. */
export function liquidSurfaceConditionGPU(particle: GPUParticleLike, system: ParticleSystem,
  sampler: GPUSurfaceQuery, options: { minimumDeformity?: number; upwardOnly?: boolean } = {}) {
  const toWorld = uniform(system.getSimulationToWorldMatrix())
    .onFrameUpdate(() => system.getSimulationToWorldMatrix());
  const sample = sampler(toWorld.mul(vec4(particle.position, 1)).xyz);
  let valid = sample.valid;
  if (options.minimumDeformity) valid = valid.and(sample.deformation!.greaterThanEqual(options.minimumDeformity));
  if (options.upwardOnly) valid = valid.and(sample.normal.y.greaterThanEqual(0));
  return valid;
}
