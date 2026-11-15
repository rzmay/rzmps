import * as THREE from 'three';
import { Storage3DTexture, type ComputeNode, type Node } from 'three/webgpu';
import {
  Break, Fn, If, Loop, float, instanceIndex, int, ivec3, storageTexture, texture3D, textureStore,
  uint, uniform, vec3, vec4,
} from 'three/tsl';
import type { ParticleSpatialGridRenderer } from '../../spatial/structures/ParticleSpatialGrid';

/** Binary conservative occupancy of the export backing, independent of its current logical rectangle. @internal */
export default class VolumeOccupancy {
  texture: Storage3DTexture;
  readonly resolution: THREE.Vector3;
  private readonly node: ComputeNode;
  private version = -1;
  private readonly sourceNode: ReturnType<typeof texture3D>;
  private readonly outputNode: ReturnType<typeof storageTexture>;
  private readonly sampleNode: ReturnType<typeof texture3D>;
  private readonly dimensionsNode;
  private readonly sourceDimensionsNode;

  constructor(source: THREE.Texture, readonly sourceResolution: THREE.Vector3) {
    this.resolution = sourceResolution.clone().divideScalar(8).ceil();
    this.texture = this.createTexture();
    this.sourceNode = texture3D(source);
    this.outputNode = storageTexture(this.texture);
    this.sampleNode = texture3D(this.texture);
    this.dimensionsNode = uniform(this.resolution);
    this.sourceDimensionsNode = uniform(sourceResolution);
    this.node = Fn(() => {
      const size = this.dimensionsNode;
      const c = ivec3(int(instanceIndex.mod(uint(size.x))), int(instanceIndex.div(uint(size.x)).mod(uint(size.y))),
        int(instanceIndex.div(uint(size.x.mul(size.y)))));
      const occupied = float(0).toVar();
      Loop(12 ** 3, ({ i }) => {
        const offset = ivec3(i.mod(12), i.div(12).mod(12), i.div(144)).sub(ivec3(2));
        const sample = c.mul(8).add(offset);
        If(vec3(sample).greaterThanEqual(0).all()
          .and(vec3(sample).lessThan(this.sourceDimensionsNode).all()), () => {
          const density = this.sourceNode
            .sample(vec3(sample).add(0.5).div(this.sourceDimensionsNode)).level(float(0)).r;
          If(density.greaterThan(0), () => { occupied.assign(1); Break(); });
        });
      });
      textureStore(this.outputNode, vec3(c), vec4(occupied, 0, 0, 1)).toWriteOnly();
    })().compute(this.resolution.x * this.resolution.y * this.resolution.z)
      .setName('rzmps.volume.rendererOccupancy');
  }

  private createTexture(): Storage3DTexture {
    const texture = new Storage3DTexture(this.resolution.x, this.resolution.y, this.resolution.z);
    texture.type = THREE.UnsignedByteType;
    texture.minFilter = texture.magFilter = THREE.NearestFilter;
    return texture;
  }

  updateSource(renderer: ParticleSpatialGridRenderer, source: THREE.Texture, dimensions: THREE.Vector3): void {
    this.sourceNode.value = source;
    if (this.sourceResolution.equals(dimensions)) return;
    this.sourceResolution.copy(dimensions);
    this.resolution.copy(dimensions).divideScalar(8).ceil();
    const previous = this.texture;
    this.texture = this.createTexture();
    this.outputNode.value = this.sampleNode.value = this.texture;
    this.node.count = this.resolution.x * this.resolution.y * this.resolution.z;
    this.version = -1;
    const device = (renderer.backend as { device: { queue: { onSubmittedWorkDone(): Promise<void> } } }).device;
    void device.queue.onSubmittedWorkDone().then(() => previous.dispose(), () => previous.dispose());
  }

  getResolutionNode(): Node<'vec3'> { return this.dimensionsNode; }
  sample(uv: Node<'vec3'>): Node<'vec4'> { return this.sampleNode.sample(uv).level(float(0)); }

  update(renderer: ParticleSpatialGridRenderer, version: number): void {
    if (version === this.version) return;
    renderer.compute(this.node);
    this.version = version;
  }

  dispose(): void { this.node.dispose(); this.texture.dispose(); }
}
