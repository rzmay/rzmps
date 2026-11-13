import * as THREE from 'three';
import { Storage3DTexture, type ComputeNode } from 'three/webgpu';
import { Break, Fn, If, Loop, float, instanceIndex, ivec3, texture3D, textureStore, vec3, vec4 } from 'three/tsl';
import type { ParticleSpatialGridRenderer } from '../../spatial/structures/ParticleSpatialGrid';

/** Binary conservative occupancy of the final visual texture, including a two-texel filtering halo. @internal */
export default class VolumeOccupancy {
  readonly texture: Storage3DTexture;
  readonly resolution: THREE.Vector3;
  private readonly node: ComputeNode;
  private version = -1;

  constructor(source: THREE.Texture, readonly sourceResolution: THREE.Vector3) {
    this.resolution = sourceResolution.clone().divideScalar(8).ceil();
    const { x, y, z } = this.resolution;
    this.texture = new Storage3DTexture(x, y, z);
    this.texture.type = THREE.UnsignedByteType;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
    this.node = Fn(() => {
      const c = ivec3(vec3(float(instanceIndex.mod(x)),
        float(instanceIndex.div(x).mod(y)), float(instanceIndex.div(x * y))));
      const occupied = float(0).toVar();
      // Store a flag, not an 8-bit density: arbitrarily small positive density must survive.
      Loop(12 ** 3, ({ i }) => {
        const offset = ivec3(i.mod(12), i.div(12).mod(12), i.div(144)).sub(ivec3(2));
        const sample = c.mul(8).add(offset);
        If(vec3(sample).greaterThanEqual(0).all().and(vec3(sample).lessThan(vec3(sourceResolution)).all()), () => {
          const density = texture3D(source).sample(vec3(sample).add(0.5).div(vec3(sourceResolution))).level(float(0)).r;
          If(density.greaterThan(0), () => { occupied.assign(1); Break(); });
        });
      });
      textureStore(this.texture, vec3(c), vec4(occupied, 0, 0, 1)).toWriteOnly();
    })().compute(x * y * z);
  }

  update(renderer: ParticleSpatialGridRenderer, version: number): void {
    if (version === this.version) return;
    renderer.compute(this.node);
    this.version = version;
  }

  dispose(): void { this.node.dispose(); this.texture.dispose(); }
}
