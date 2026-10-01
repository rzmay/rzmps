import * as THREE from 'three';
import { MeshBVH, type MeshBVHOptions } from 'three-mesh-bvh';
import acceptMultiple from '../../helpers/acceptMultiple';
import isPointInMesh from '../../helpers/isPointInMesh';
import tagsIntersect from '../../helpers/tagsIntersect';
import type { StrictMultiple } from '../../types/Multiple';
import type { Tag } from '../../types/Tag';

export interface BoidAffectorOptions {
  position: THREE.Vector3;
  weight: number;
  distance: number;
  geometry: THREE.BufferGeometry;
  bvhOptions: MeshBVHOptions;
  tags: StrictMultiple<Tag>;
  inverted: boolean;
}

enum Weight {
  Target = 1,
  Obstacle = -1,
}

class BoidAffector extends THREE.Object3D {
  private static readonly _doubleSidedMaterial = new THREE.MeshBasicMaterial(
    { side: THREE.DoubleSide },
  );

  static readonly Weight = Weight;

  static Box(
    options?: Partial<BoidAffectorOptions>,
    ...args: ConstructorParameters<typeof THREE.BoxGeometry>
  ): BoidAffector {
    return new BoidAffector({ ...options, geometry: new THREE.BoxGeometry(...args) });
  }

  static Sphere(
    options?: Partial<BoidAffectorOptions>,
    ...args: ConstructorParameters<typeof THREE.SphereGeometry>
  ): BoidAffector {
    return new BoidAffector({ ...options, geometry: new THREE.SphereGeometry(...args) });
  }

  static Cone(
    options?: Partial<BoidAffectorOptions>,
    ...args: ConstructorParameters<typeof THREE.ConeGeometry>
  ): BoidAffector {
    return new BoidAffector({ ...options, geometry: new THREE.ConeGeometry(...args) });
  }

  static Torus(
    options?: Partial<BoidAffectorOptions>,
    ...args: ConstructorParameters<typeof THREE.TorusGeometry>
  ): BoidAffector {
    return new BoidAffector({ ...options, geometry: new THREE.TorusGeometry(...args) });
  }

  weight: number;
  distance: number;
  inverted: boolean;
  tags?: Tag[];
  bvhOptions?: MeshBVHOptions;

  private _geometry?: THREE.BufferGeometry;
  private _bvh?: MeshBVH;
  private _mesh: THREE.Mesh;
  private localSamplePoint = new THREE.Vector3();
  private worldSamplePoint = new THREE.Vector3();
  private influenceSamplePoint = new THREE.Vector3();
  private influenceLocalPosition = new THREE.Vector3();

  set geometry(value: THREE.BufferGeometry | undefined) {
    this._geometry = value;
    this._bvh = value ? new MeshBVH(value, this.bvhOptions) : undefined;
    this._mesh.geometry = value ?? new THREE.BufferGeometry();
  }

  get geometry(): THREE.BufferGeometry | undefined {
    return this._geometry;
  }

  get bvh(): MeshBVH | undefined {
    return this._bvh;
  }

  constructor(options: Partial<BoidAffectorOptions> = {}) {
    super();
    this._mesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      BoidAffector._doubleSidedMaterial,
    );

    if (options.position) {
      this.position.copy(options.position);
    }

    this.weight = options.weight ?? Weight.Target;
    this.distance = options.distance ?? 1;
    this.inverted = options.inverted ?? false;
    this.tags = acceptMultiple(options.tags);
    this.bvhOptions = options.bvhOptions;
    this.geometry = options.geometry;
  }

  matchesTags(tags?: Tag[]): boolean {
    return !this.tags?.length || tagsIntersect(this.tags, tags ?? []);
  }

  samplePoint(position: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
    this.updateWorldMatrix(true, false);

    if (!this._bvh) {
      return this.getWorldPosition(target);
    }

    this.localSamplePoint.copy(position);
    this.worldToLocal(this.localSamplePoint);

    const hit = this._bvh.closestPointToPoint(this.localSamplePoint);

    if (!hit) {
      return this.getWorldPosition(target);
    }

    this.worldSamplePoint.copy(hit.point);
    this.localToWorld(this.worldSamplePoint);

    return target.copy(this.worldSamplePoint);
  }

  getInfluenceDirection(position: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
    this.samplePoint(position, this.influenceSamplePoint);
    target.copy(position).sub(this.influenceSamplePoint);

    if (!this._geometry || target.lengthSq() === 0) return target;

    this.influenceLocalPosition.copy(position);
    this.worldToLocal(this.influenceLocalPosition);

    const inside = isPointInMesh(this.influenceLocalPosition, this._mesh);
    if (inside !== this.inverted) target.multiplyScalar(-1);

    return target;
  }
}

export default BoidAffector;
