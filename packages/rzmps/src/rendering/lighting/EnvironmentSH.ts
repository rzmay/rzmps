import * as THREE from 'three';
import { StorageBufferAttribute, type Node, type WebGPURenderer } from 'three/webgpu';
import { Fn, If, Loop, cos, float, instanceIndex, sin, sqrt, storage, texture, uint, vec2, vec3, vec4 }
  from 'three/tsl';
import { destroyStorageAttribute, initializeStorageAttribute } from '../../utils/gpu/storage.utils';
import { sampleCubeRadianceGPU, shBasisGPU, shRadianceGPU } from './lightingGrid.utils';

/** Cached GPU-only low-frequency environment projection; avoids missing narrow HDR light sources. */
export default class EnvironmentSH {
  private readonly coefficientsAttribute = new StorageBufferAttribute(new Float32Array(9 * 4), 4);
  private readonly coefficients = storage(this.coefficientsAttribute, 'vec4', 9);
  private readonly partialAttribute: StorageBufferAttribute;
  private readonly project;
  private readonly reduce;
  private version = -1;
  private renderer?: WebGPURenderer;

  constructor(private readonly environment: THREE.Texture) {
    const cube = environment instanceof THREE.CubeTexture;
    const image = environment.image as { width?: number; height?: number };
    const width = cube ? 4096 : Math.max(64, image.width ?? 1);
    const height = cube ? 1 : Math.max(32, image.height ?? 1);
    const samples = width * height, chunks = Math.ceil(samples / 256);
    this.partialAttribute = new StorageBufferAttribute(new Float32Array(chunks * 9 * 4), 4);
    const partial = storage(this.partialAttribute, 'vec4', chunks * 9);
    const map = cube ? undefined : texture(environment);

    // Integrate every equirectangular texel with its exact solid angle. Bright, small HDR sources
    // cannot disappear between the cascade's few directional samples. Cubemaps use equal-area quadrature.
    this.project = Fn(() => {
      const sums = Array.from({ length: 9 }, () => vec3(0).toVar());
      Loop(256, ({ i }) => {
        const index = instanceIndex.mul(256).add(uint(i));
        If(index.lessThan(samples), () => {
          const u = float(index.mod(width)).add(0.5).div(width);
          const v = float(index.div(width)).add(0.5).div(height);
          const y = cube ? float(1).sub(float(index).add(0.5).mul(2 / samples))
            : sin(v.sub(0.5).mul(Math.PI));
          const angle = cube ? float(index).mul(Math.PI * (3 - Math.sqrt(5))) : u.sub(0.5).mul(2 * Math.PI);
          const radius = sqrt(float(1).sub(y.mul(y)).max(0));
          const direction = vec3(radius.mul(cos(angle)), y, radius.mul(sin(angle)));
          const radiance = cube ? sampleCubeRadianceGPU(environment as THREE.CubeTexture, direction)
            : map!.sample(vec2(u, v)).level(float(0)).xyz;
          const area = cube ? float(4 * Math.PI / samples)
            : sin(v.add(0.5 / height).sub(0.5).mul(Math.PI))
              .sub(sin(v.sub(0.5 / height).sub(0.5).mul(Math.PI))).mul(2 * Math.PI / width);
          const basis = shBasisGPU(direction);
          sums.forEach((sum, coefficient) => sum.addAssign(radiance.mul(area.mul(basis[coefficient]))));
        });
      });
      sums.forEach((sum, coefficient) => partial.element(instanceIndex.mul(9).add(coefficient)).assign(vec4(sum, 0)));
    })().compute(chunks).setName('rzmps.lighting.environment.project');

    this.reduce = Fn(() => {
      const sum = vec3(0).toVar();
      Loop(chunks, ({ i }) => { sum.addAssign(partial.element(uint(i).mul(9).add(instanceIndex)).xyz); });
      this.coefficients.element(instanceIndex).assign(vec4(sum, 0));
    })().compute(9).setName('rzmps.lighting.environment.reduce');
  }

  update(renderer: WebGPURenderer): void {
    this.renderer = renderer;
    if (this.version === this.environment.version) return;
    initializeStorageAttribute(renderer, this.partialAttribute, false);
    initializeStorageAttribute(renderer, this.coefficientsAttribute, false);
    renderer.compute([this.project, this.reduce]);
    this.version = this.environment.version;
  }

  sample(direction: Node<'vec3'>): Node<'vec3'> {
    return shRadianceGPU(Array.from({ length: 9 }, (_, i) => this.coefficients.element(i).xyz), direction);
  }

  invalidate(): void { this.version = -1; }

  get allocatedBytes(): number {
    return this.partialAttribute.array.byteLength + this.coefficientsAttribute.array.byteLength;
  }

  dispose(renderer = this.renderer): void {
    this.project.dispose(); this.reduce.dispose();
    const release = () => {
      for (const attribute of [this.partialAttribute, this.coefficientsAttribute]) {
        if (renderer) destroyStorageAttribute(renderer, attribute);
        attribute.dispose();
      }
    };
    if (renderer) {
      const device = (renderer.backend as unknown as { device: {
        queue: { onSubmittedWorkDone(): Promise<void> };
      } }).device;
      void device.queue.onSubmittedWorkDone().then(release, release);
    } else release();
  }
}
