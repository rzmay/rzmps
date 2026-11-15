import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';

export const DEPTH_CAPTURE_OBJECT = '__rzmps_depthCapture';

/** Depth-only variants that preserve visible material groups, face culling and alpha cutouts. @internal */
export default class DepthMaterialCache {
  private readonly variants = new WeakMap<THREE.Material, { material: THREE.Material; key: string }>();

  constructor(private readonly gpu: boolean) {}

  private get(source: THREE.Material): THREE.Material {
    let record = this.variants.get(source);
    if (!record) {
      const material = this.gpu ? new MeshBasicNodeMaterial() : new THREE.MeshDepthMaterial();
      material.colorWrite = false;
      material.depthWrite = material.depthTest = true;
      record = { material, key: '' };
      this.variants.set(source, record);
      const release = () => {
        source.removeEventListener('dispose', release);
        material.dispose();
        this.variants.delete(source);
      };
      source.addEventListener('dispose', release);
    }
    const input = source as THREE.Material & { map?: THREE.Texture; alphaMap?: THREE.Texture;
      displacementMap?: THREE.Texture; displacementScale?: number; displacementBias?: number;
      wireframe?: boolean; wireframeLinewidth?: number; vertexColors?: boolean };
    const alphaTest = Math.max(source.alphaTest, source.transparent ? 1e-6 : 0);
    const key = [source.version, source.side, alphaTest > 0, input.map?.uuid, input.alphaMap?.uuid,
      input.displacementMap?.uuid, input.wireframe, input.vertexColors,
      source.clippingPlanes?.length, source.clipIntersection].join(':');
    Object.assign(record.material, {
      side: source.side, visible: source.visible && (!source.transparent || source.opacity > 0),
      opacity: source.opacity, alphaTest,
      map: input.map ?? null, alphaMap: input.alphaMap ?? null, displacementMap: input.displacementMap ?? null,
      displacementScale: input.displacementScale ?? 1, displacementBias: input.displacementBias ?? 0,
      wireframe: input.wireframe ?? false, wireframeLinewidth: input.wireframeLinewidth ?? 1,
      vertexColors: input.vertexColors ?? false,
      clippingPlanes: source.clippingPlanes, clipIntersection: source.clipIntersection,
      polygonOffset: source.polygonOffset, polygonOffsetFactor: source.polygonOffsetFactor,
      polygonOffsetUnits: source.polygonOffsetUnits,
    });
    if (key !== record.key) { record.key = key; record.material.needsUpdate = true; }
    return record.material;
  }

  /** Temporarily replace per-group materials; restore originals even if a render fails. */
  apply(scene: THREE.Scene): () => void {
    const materials: Array<[THREE.Mesh, THREE.Material | THREE.Material[]]> = [];
    const hidden: THREE.Object3D[] = [];
    const override = scene.overrideMaterial;
    scene.traverse(object => {
      if (!object.visible) return;
      if (object.userData[DEPTH_CAPTURE_OBJECT]) {
        hidden.push(object); object.visible = false;
      } else if (object instanceof THREE.Mesh) {
        materials.push([object, object.material]);
        object.material = override ? this.get(override) : Array.isArray(object.material)
          ? object.material.map(material => this.get(material)) : this.get(object.material);
      }
    });
    scene.overrideMaterial = null;
    return () => {
      scene.overrideMaterial = override;
      for (const [object, material] of materials) object.material = material;
      hidden.forEach(object => { object.visible = true; });
    };
  }
}
