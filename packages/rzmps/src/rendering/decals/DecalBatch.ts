import * as THREE from 'three';
import applyDecalWarp from './applyDecalWarp';
import { PARTICLE_RENDERER_OBJECT_KEY } from '../renderers/LiveCubemap';

export interface DecalBatchSlot {
  geometry: number;
  instance: number;
  vertices: number;
}

/** One compatible shared material, geometrically growing storage, independently recyclable decal slots. @internal */
export default class DecalBatch {
  readonly mesh: THREE.BatchedMesh;
  private slots = 16;
  private vertices = 1024;
  private live = 0;
  private liveVertices = 0;
  growths = 0;
  repacks = 0;
  private reclaimed = 0;

  private static readonly resources = new WeakMap<object, number>();
  private static nextResource = 1;

  /** Per-instance tint/alpha do not split otherwise compatible templates. Opaque resources stay distinct. */
  static materialKey(material: THREE.Material): string {
    const ignored = new Set([
      'id',
      'uuid',
      'name',
      'color',
      'opacity',
      'version',
      'userData',
      '_listeners',
      'transparent',
      'depthWrite',
    ]);
    const values = Object.entries(material)
      .filter(([key, value]) => !ignored.has(key) && typeof value !== 'function')
      .map(([key, value]) => {
        if (!value || typeof value !== 'object') return [key, value];
        if ('uuid' in value) return [key, value.uuid];
        if ('toArray' in value && typeof value.toArray === 'function') return [key, value.toArray()];
        if (Array.isArray(value) && value.every(item => item === null || typeof item !== 'object')) return [key, value];
        let id = this.resources.get(value);
        if (!id) {
          id = this.nextResource++;
          this.resources.set(value, id);
        }
        return [key, id];
      });
    return JSON.stringify([material.customProgramCacheKey(), values]);
  }

  constructor(
    readonly template: THREE.Material,
    material: THREE.Material,
    parent: THREE.Object3D,
  ) {
    material.transparent = true;
    material.depthWrite = false;
    applyDecalWarp(material);
    this.mesh = new THREE.BatchedMesh(this.slots, this.vertices, 0, material);
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
    this.mesh.userData[PARTICLE_RENDERER_OBJECT_KEY] = true;
    parent.add(this.mesh);
  }

  add(geometry: THREE.BufferGeometry, receiver: THREE.Object3D, color: THREE.Color, alpha: number): DecalBatchSlot {
    const vertices = geometry.getAttribute('position').count;
    if (this.live >= this.slots) {
      this.slots *= 2;
      this.mesh.setInstanceCount(this.slots);
      // BatchedMesh replaces its matrix/color/indirection textures when capacity changes.
      // Rebuild material bindings so rendered marks do not retain disposed texture resources.
      this.mesh.material.needsUpdate = true;
      this.growths++;
    }
    if (this.mesh.unusedVertexCount < vertices && this.reclaimed) {
      this.mesh.optimize();
      this.reclaimed = 0;
      this.repacks++;
    }
    if (this.mesh.unusedVertexCount < vertices) {
      while (this.mesh.unusedVertexCount + this.vertices < vertices) this.vertices *= 2;
      this.vertices *= 2;
      this.mesh.setGeometrySize(this.vertices, 0);
      this.growths++;
    }
    const id = this.mesh.addGeometry(geometry),
      instance = this.mesh.addInstance(id);
    this.live++;
    this.liveVertices += vertices;
    const slot = { geometry: id, instance, vertices };
    this.update(slot, receiver, color, alpha);
    return slot;
  }

  update(slot: DecalBatchSlot, receiver: THREE.Object3D, color: THREE.Color, alpha: number): void {
    receiver.updateWorldMatrix(true, false);
    this.mesh.updateWorldMatrix(true, false);
    this.mesh.setMatrixAt(slot.instance, this.mesh.matrixWorld.clone().invert().multiply(receiver.matrixWorld));
    this.mesh.setColorAt(slot.instance, new THREE.Vector4(color.r, color.g, color.b, alpha));
    this.mesh.receiveShadow ||= receiver.receiveShadow;
  }

  remove(slot: DecalBatchSlot): void {
    this.mesh.deleteInstance(slot.instance);
    this.mesh.deleteGeometry(slot.geometry);
    this.live--;
    this.liveVertices -= slot.vertices;
    this.reclaimed += slot.vertices;
  }

  get diagnostics() {
    const geometryBytes =
      Object.values(this.mesh.geometry.attributes).reduce((bytes, attribute) => bytes + attribute.array.byteLength, 0) +
      (this.mesh.geometry.index?.array.byteLength ?? 0);
    const internals = this.mesh as unknown as Record<string, { image?: { data?: ArrayBufferView } }>;
    const instanceTextureBytes = ['_matricesTexture', '_colorsTexture', '_indirectTexture'].reduce(
      (bytes, key) => bytes + (internals[key]?.image?.data?.byteLength ?? 0),
      0,
    );
    return {
      geometryBytes,
      instanceTextureBytes,
      reservedSlots: this.slots,
      liveVertices: this.liveVertices,
      reservedVertices: this.vertices,
      growths: this.growths,
      repacks: this.repacks,
    };
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.mesh.material.dispose();
  }
}
