import * as THREE from 'three';
import type Particle from '../../core/Particle';

export enum MaterialCopySampleMode {
  UVPatch = 0,
  Color = 1,
  Texture = 2,
}

export type MaterialTarget = THREE.Material | THREE.Mesh;
export interface SurfacePatch {
  uv: THREE.Vector2;
  /** World-space UV gradients; degenerate UVs produce zero gradients. */
  u: THREE.Vector3;
  v: THREE.Vector3;
}

/** Accessible inputs at a world-space surface sample. */
export interface SurfaceSample {
  material?: THREE.Material;
  surface?: SurfacePatch;
  point: THREE.Vector3;
}

/** Reuses the triangle's UV chart rather than the projector's generated decal UVs. */
export function intersectionSurface(hit: THREE.Intersection): SurfaceSample {
  const mesh = hit.object as THREE.Mesh;
  const material = Array.isArray(mesh.material) ? mesh.material[hit.face?.materialIndex ?? 0] : mesh.material;
  const position = mesh.geometry.getAttribute('position');
  const uv = mesh.geometry.getAttribute('uv');
  const face = hit.face;
  if (!uv || !face) return { material, point: hit.point };

  const vertex = (index: number) => new THREE.Vector3().fromBufferAttribute(position, index)
    .applyMatrix4(mesh.matrixWorld);
  const coordinate = (index: number) => new THREE.Vector2(uv.getX(index), uv.getY(index));
  return { material, point: hit.point,
    surface: surfacePatch(hit.point, vertex(face.a), vertex(face.b), vertex(face.c),
      coordinate(face.a), coordinate(face.b), coordinate(face.c)) };
}

/** Shared CPU binding math for module births and geometry consumers with a known surface sample. */
export function bindSurface(particle: Particle, id: number, world: THREE.Matrix4,
  sample: Pick<SurfaceSample, 'surface' | 'point'>, mode = MaterialCopySampleMode.UVPatch): void {
  const surface = sample.surface;
  particle.materialCopyU.set(0, 0, 0, 0);
  particle.materialCopyV.set(0, 0, 0, 0);
  if (!surface) {
    particle.materialCopy.set(id, 0.5, 0.5, mode === MaterialCopySampleMode.Color ? mode : 2);
    return;
  }

  // A color sample belongs to the source contact, even when an emitter spreads births around it.
  const delta = mode === MaterialCopySampleMode.Color ? new THREE.Vector3()
    : new THREE.Vector3().setFromMatrixPosition(world).sub(sample.point);
  particle.materialCopy.set(id, surface.uv.x + surface.u.dot(delta), surface.uv.y + surface.v.dot(delta),
    mode === MaterialCopySampleMode.UVPatch ? -1 : mode);
  const e = world.elements;
  const axis = (i: number) => new THREE.Vector3(e[i], e[i + 1], e[i + 2]);
  particle.materialCopyU.set(surface.u.dot(axis(0)), surface.u.dot(axis(4)), surface.u.dot(axis(8)), 0);
  particle.materialCopyV.set(surface.v.dot(axis(0)), surface.v.dot(axis(4)), surface.v.dot(axis(8)), 0);
}

/** Affine extension of one world-space triangle's UV mapping. */
export function surfacePatch(point: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3,
  ta: THREE.Vector2, tb: THREE.Vector2, tc: THREE.Vector2): SurfacePatch {
  const e1 = b.clone().sub(a);
  const e2 = c.clone().sub(a);
  const aa = e1.dot(e1);
  const ab = e1.dot(e2);
  const bb = e2.dot(e2);
  const determinant = aa * bb - ab * ab;
  const u = new THREE.Vector3();
  const v = new THREE.Vector3();

  // Dual edge vectors map a world displacement into triangle coordinates.
  if (Math.abs(determinant) > 1e-16) {
    const dual1 = e1.clone().multiplyScalar(bb).addScaledVector(e2, -ab).divideScalar(determinant);
    const dual2 = e2.clone().multiplyScalar(aa).addScaledVector(e1, -ab).divideScalar(determinant);
    u.copy(dual1).multiplyScalar(tb.x - ta.x).addScaledVector(dual2, tc.x - ta.x);
    v.copy(dual1).multiplyScalar(tb.y - ta.y).addScaledVector(dual2, tc.y - ta.y);
  }

  const offset = point.clone().sub(a);
  return { uv: ta.clone().add(new THREE.Vector2(u.dot(offset), v.dot(offset))), u, v };
}

export function targetMaterial(target?: MaterialTarget): THREE.Material | undefined {
  if (!target) return;
  if (target instanceof THREE.Material) return target;
  return Array.isArray(target.material) ? target.material[0] : target.material;
}

/** Stable snapshot IDs scoped to one particle-system tree. Textures remain borrowed. */
export class MaterialCopyRegistry {
  readonly sources: THREE.Material[] = [new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 1,
  })];
  readonly transforms: Array<Record<string, number[]>> = [{}];
  private snapshots = new WeakMap<THREE.Material, Map<string, number>>();

  register(material?: THREE.Material): number {
    if (!material) return 0;

    const m = material as THREE.MeshStandardMaterial;
    const transforms: Record<string, number[]> = {};

    // Snapshot scalar values and transforms, while retaining borrowed texture resources.
    const signature = [material.version, m.color?.r, m.color?.g, m.color?.b, m.normalScale?.x,
      m.normalScale?.y, m.normalMapType, material.opacity, m.roughness, m.metalness,
      m.envMap?.uuid, m.envMapIntensity, m.envMapRotation?.toArray().join(','),
      ...['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'alphaMap'].map(key => {
        const t = (m as unknown as Record<string, THREE.Texture>)[key];
        if (!t) return '';
        if (t.matrixAutoUpdate) t.updateMatrix();
        transforms[key] = [...t.matrix.elements, t.wrapS, t.wrapT];
        return `${t.uuid}:${transforms[key].join(',')}`;
      })].join(';');

    let snapshots = this.snapshots.get(material);
    if (!snapshots) {
      snapshots = new Map();
      this.snapshots.set(material, snapshots);
    }
    const old = snapshots.get(signature);
    if (old !== undefined) return old;

    const id = this.sources.length;
    this.sources.push(material.clone());
    this.transforms.push(transforms);
    snapshots.set(signature, id);
    return id;
  }

  dispose(): void {
    this.sources.forEach(material => material.dispose());
    this.sources.length = 0;
    this.transforms.length = 0;
    this.snapshots = new WeakMap();
  }
}
