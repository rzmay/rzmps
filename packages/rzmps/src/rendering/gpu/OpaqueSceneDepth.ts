import * as THREE from 'three';
import { MeshBasicNodeMaterial, NodeFrame, ViewportDepthTextureNode, WebGPURenderer } from 'three/webgpu';
import { NodeUpdateType, uniform, vec3 } from 'three/tsl';
import { DEPTH_CAPTURE_OBJECT } from '../DepthMaterialCache';
import { PARTICLE_RENDERER_OBJECT_KEY } from '../renderers/LiveCubemap';

/** Snapshot the existing opaque depth before transmission/transparent draws, without a scene prepass. @internal */
export default class OpaqueSceneDepth {
  private readonly defaultDepth = new THREE.DepthTexture(1, 1);
  readonly node = new ViewportDepthTextureNode(undefined, undefined, this.defaultDepth);
  private readonly frame = new NodeFrame();
  private readonly geometry = new THREE.PlaneGeometry(0, 0);
  private readonly material = new MeshBasicNodeMaterial({ colorWrite: false, depthWrite: false, depthTest: false });
  private readonly mesh = new THREE.Mesh(this.geometry, this.material);
  private readonly root = new THREE.Group();
  private readonly textures = new Set<THREE.Texture>();

  constructor() {
    // A shader must not refresh this snapshot after transparent objects have written main depth.
    this.node.updateBeforeType = NodeUpdateType.NONE;
    this.root.name = 'Opaque scene depth snapshot';
    this.root.renderOrder = this.mesh.renderOrder = Infinity;
    this.root.layers.enableAll(); this.mesh.layers.enableAll();
    this.root.userData[DEPTH_CAPTURE_OBJECT] = true;
    this.root.userData[PARTICLE_RENDERER_OBJECT_KEY] = true;
    this.geometry.boundingBox = new THREE.Box3();
    this.mesh.frustumCulled = false;
    this.root.add(this.mesh);
    // Object callbacks also run during compileAsync, when no render pass is open.
    // Node updates run only for an actual draw, so a compilation cannot copy stale depth.
    this.material.colorNode = vec3(uniform(0).onObjectUpdate(({ renderer, scene }) => {
      if (!(renderer instanceof WebGPURenderer) || scene?.overrideMaterial) return 0;
      this.frame.renderer = renderer;
      this.node.updateReference(this.frame);
      this.node.updateBefore(this.frame);
      this.textures.add(this.node.value);
      return 0;
    }));
  }

  attach(scene: THREE.Scene | undefined, enabled: boolean): void {
    if (enabled && scene) {
      if (this.root.parent !== scene) scene.add(this.root);
    } else this.root.removeFromParent();
  }

  dispose(): void {
    this.root.removeFromParent();
    this.geometry.dispose(); this.material.dispose();
    this.textures.add(this.node.value);
    this.textures.add(this.defaultDepth);
    this.textures.forEach(texture => texture.dispose());
    this.textures.clear();
  }
}
