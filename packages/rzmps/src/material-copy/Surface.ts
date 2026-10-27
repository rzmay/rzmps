import * as THREE from 'three';

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
      m.normalScale?.y, material.opacity, m.roughness, m.metalness,
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
