import * as THREE from 'three';
import {
  batchIndirectIndex, ivec2, positionGeometry, textureLoad, uniform, uniformArray, vec4,
} from 'three/tsl';
import type { Node, WebGPURenderer } from 'three/webgpu';
import Appearance from '../material-copy/Appearance';
import { MaterialCopyRegistry, MaterialCopySampleMode } from '../material-copy/Surface';
import type Particle from '../Particle';

interface Part {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  variant: number;
}

type Shader = Parameters<Appearance['shader']>[0];
export type AppearanceNodes = ReturnType<Appearance['nodes']>;

/** Batched geometry and texture-backed CPU bindings; no simulation storage buffers are added. */
export default class MeshBatch {
  readonly mesh: THREE.BatchedMesh;
  readonly material: THREE.Material;
  readonly parts: Part[] = [];
  readonly registry = new MaterialCopyRegistry();
  readonly appearance = new Appearance(this.registry);
  readonly sourceIDs: number[] = [];
  readonly sourceNode: ReturnType<typeof uniformArray>;
  readonly data = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  readonly dataSize = new THREE.Vector2(1, 1);
  private geometryIDs: number[] = [];
  private allocated = 0;
  private visibleCount = 0;
  private gpuMode = false;
  private readonly color = new THREE.Vector4();
  private readonly identity = new THREE.Matrix4();
  private readonly dummy = new THREE.Object3D();

  constructor(readonly sources: readonly THREE.Mesh[], capacity: number) {
    // Normalize owned copies, including material groups, without changing the source assets.
    sources.forEach((source, variant) => {
      const geometry = source.geometry;
      const count = geometry.index?.count ?? geometry.getAttribute('position').count;
      const materials = Array.isArray(source.material) ? source.material : [source.material];
      const groups = Array.isArray(source.material) ? geometry.groups : [{
        start: 0, count, materialIndex: 0,
      }];
      if (!groups.length) throw new Error('Batched source material arrays require geometry groups.');

      for (const group of groups) {
        const material = materials[group.materialIndex ?? 0];
        if (!material) throw new Error('Batched geometry group has no material.');
        const start = Math.max(group.start, geometry.drawRange.start);
        const end = Math.min(group.start + group.count, geometry.drawRange.start + geometry.drawRange.count,
          count);
        if (end <= start) continue;

        // Preserve indexed vertex sharing, including when mixing indexed and non-indexed assets.
        const remap = new Map<number, number>();
        const vertices: number[] = [];
        const indices = new Uint32Array(end - start);
        for (let i = start; i < end; i++) {
          const sourceIndex = geometry.index?.getX(i) ?? i;
          let index = remap.get(sourceIndex);
          if (index === undefined) {
            index = vertices.length;
            remap.set(sourceIndex, index);
            vertices.push(sourceIndex);
          }
          indices[i - start] = index;
        }

        const part = new THREE.BufferGeometry();
        part.setIndex(new THREE.BufferAttribute(indices, 1));
        for (const key of ['position', 'normal', 'uv', 'color']) {
          const attr = key === 'color' && !material.vertexColors ? undefined : geometry.getAttribute(key);
          const size = key === 'uv' ? 2 : key === 'color' ? 4 : 3;
          const values = new Float32Array(vertices.length * size);
          for (let i = 0; i < vertices.length; i++) {
            for (let c = 0; c < size; c++) {
              values[i * size + c] = attr && c < attr.itemSize
                ? attr.getComponent(vertices[i], c) : key === 'color' ? 1 : 0;
            }
          }
          part.setAttribute(key, new THREE.BufferAttribute(values, size));
        }
        if (!geometry.hasAttribute('normal')) part.computeVertexNormals();
        this.parts.push({ geometry: part, material, variant });
      }
    });
    if (!this.parts.length) throw new Error('Batched meshes require nonempty geometry.');

    this.validateMaterials();
    this.material = this.parts[0].material.clone();
    // The source palette supplies these factors and maps. Other shader settings remain shared.
    const material = this.material as THREE.MeshStandardMaterial;
    material.color?.set(0xffffff);
    material.opacity = 1;
    material.roughness = 1;
    material.metalness = 1;
    material.normalScale?.set(1, 1);
    for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'alphaMap'] as const) material[key] = null;
    material.vertexColors = true;
    material.transparent = true;

    const vertices = this.parts.reduce((sum, part) => sum + part.geometry.getAttribute('position').count, 0);
    this.mesh = new THREE.BatchedMesh(Math.max(1, capacity * this.parts.length), vertices,
      this.parts.reduce((sum, part) => sum + part.geometry.index!.count, 0), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.perObjectFrustumCulled = false;
    this.geometryIDs = this.parts.map(part => this.mesh.addGeometry(part.geometry));
    this.sourceIDs.push(...this.parts.map(part => this.registry.register(part.material)));
    this.sourceNode = uniformArray(this.sourceIDs, 'float');
    this.data.minFilter = this.data.magFilter = THREE.NearestFilter;
    this.data.generateMipmaps = false;
  }

  private validateMaterials(): void {
    const first = this.parts[0].material;
    for (const { material } of this.parts) {
      if (material.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile
        || 'isShaderMaterial' in material || 'isNodeMaterial' in material) {
        throw new Error('Batched meshes require built-in materials without custom shader hooks.');
      }
    }
    const varying = new Set(['uuid', 'name', 'color', 'opacity', 'roughness', 'metalness', 'normalScale',
      'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'metadata', 'userData', 'vertexColors']);
    const reference = first.toJSON() as unknown as Record<string, unknown>;

    for (const { material } of this.parts) {
      if (material === first) continue;
      const json = material.toJSON() as unknown as Record<string, unknown>;
      for (const key of new Set([...Object.keys(reference), ...Object.keys(json)])) {
        if (varying.has(key) || key === 'textures' || key === 'images') continue;
        if (JSON.stringify(json[key]) !== JSON.stringify(reference[key])) {
          throw new Error(`Batched mesh materials must share shader settings (${key} differs).`);
        }
      }
    }
  }

  sync(renderer?: THREE.WebGLRenderer | WebGPURenderer): void {
    this.parts.forEach((part, i) => { this.sourceIDs[i] = this.registry.register(part.material); });
    this.appearance.sync(undefined, MaterialCopySampleMode.Texture, renderer);
  }

  /** Each slot reserves the same candidate parts, preserving draw-to-particle addressing across sorts. */
  private ensureSlots(count: number): void {
    const required = count * this.parts.length;
    if (required > this.mesh.maxInstanceCount) {
      this.mesh.setInstanceCount(2 ** Math.ceil(Math.log2(required)));
      // Resizing replaces Three.js's batching textures; evict shaders retaining the old bindings.
      this.material.dispose();
      this.material.needsUpdate = true;
    }
    while (this.allocated < required) {
      const part = this.allocated % this.parts.length;
      const id = this.mesh.addInstance(this.geometryIDs[part]);
      this.mesh.setColorAt(id, new THREE.Vector4(1, 1, 1, 1));
      this.mesh.setVisibleAt(id, false);
      this.allocated++;
    }
  }

  private setVisibleCount(count: number): void {
    for (let i = count; i < this.visibleCount; i++) this.mesh.setVisibleAt(i, false);
    this.visibleCount = count;
  }

  updateCPU(particles: Particle[], select: (particle: Particle) => number): void {
    this.ensureSlots(particles.length);
    this.setVisibleCount(particles.length * this.parts.length);
    this.mesh.sortObjects = true;

    const texels = Math.max(1, particles.length * 3);
    // Grow geometrically so particle births do not reallocate the GPU texture every frame.
    const width = 2 ** Math.ceil(Math.log2(Math.sqrt(texels)));
    const height = 2 ** Math.ceil(Math.log2(Math.ceil(texels / width)));
    if ((this.data.image.data?.length ?? 0) < width * height * 4) {
      this.data.dispose();
      this.data.image = { data: new Float32Array(width * height * 4), width, height };
      this.dataSize.set(width, height);
    }
    const data = this.data.image.data as Float32Array;

    particles.forEach((particle, slot) => {
      const variant = select(particle);
      this.dummy.position.copy(particle.position);
      this.dummy.rotation.setFromVector3(particle.rotation);
      this.dummy.scale.copy(particle.scale);
      this.dummy.updateMatrix();
      this.color.set(particle.color.r, particle.color.g, particle.color.b, particle.alpha);
      particle.materialCopy.toArray(data, slot * 12);
      particle.materialCopyU.toArray(data, slot * 12 + 4);
      particle.materialCopyV.toArray(data, slot * 12 + 8);

      this.parts.forEach((part, candidate) => {
        const id = slot * this.parts.length + candidate;
        this.mesh.setVisibleAt(id, part.variant === variant);
        if (part.variant !== variant) return;
        this.mesh.setMatrixAt(id, this.dummy.matrix);
        this.mesh.setColorAt(id, this.color);
      });
    });
    this.data.needsUpdate = true;
    this.gpuMode = false;
  }

  updateGPU(count: number): void {
    this.ensureSlots(count);
    const required = count * this.parts.length;
    this.setVisibleCount(required);
    this.mesh.sortObjects = false;

    if (!this.gpuMode) {
      for (let i = 0; i < this.allocated; i++) {
        this.mesh.setMatrixAt(i, this.identity);
        this.mesh.setColorAt(i, new THREE.Vector4(1, 1, 1, 1));
      }
    }
    for (let i = 0; i < required; i++) this.mesh.setVisibleAt(i, true);
    this.gpuMode = true;
  }

  get slot(): Node<'uint'> {
    return batchIndirectIndex.div(this.parts.length).toUint();
  }

  get variant(): Node<'float'> {
    return uniformArray(this.parts.map(part => part.variant), 'float').element(
      batchIndirectIndex.mod(this.parts.length),
    ) as unknown as Node<'float'>;
  }

  sourceAppearance(): AppearanceNodes {
    const id = this.sourceNode.element(batchIndirectIndex.mod(this.parts.length)) as unknown as Node<'float'>;
    return this.appearance.nodes(vec4(id, 0, 0, MaterialCopySampleMode.Texture), vec4(0), vec4(0));
  }

  cpuCopyAppearance(appearance: Appearance): AppearanceNodes {
    const size = uniform(this.dataSize);
    const read = (column: number) => {
      const offset = this.slot.mul(3).add(column).toFloat();
      return textureLoad(this.data, ivec2(offset.mod(size.x).toInt(), offset.div(size.x).toInt()));
    };
    return appearance.nodes(read(0), read(1), read(2), positionGeometry);
  }

  shader(shader: Shader, inherited?: Appearance): void {
    // The source palette uses separate names so collision copying can multiply it independently.
    this.appearance.shader(shader, true);
    shader.vertexShader = shader.vertexShader
      .replace(/attribute vec4 materialCopy\w*;/g, '')
      .replace('vMaterialCopy = materialCopy;',
        'vMaterialCopy = vec4(batchSources[int(getIndirectIndex(gl_DrawID)) % BATCH_PARTS], 0., 0., 2.);')
      .replace('vMaterialCopyU = materialCopyU;', 'vMaterialCopyU = vec4(0.);')
      .replace('vMaterialCopyV = materialCopyV;', 'vMaterialCopyV = vec4(0.);');
    const rename = (source: string) => source
      .replace(/\bcopy([A-Z]\w*)/g, 'source$1')
      .replace(/\bvCopy(\w*)/g, 'vSource$1')
      .replace(/\bvMaterialCopy(\w*)/g, 'vSourceMaterial$1');
    shader.vertexShader = rename(shader.vertexShader);
    shader.fragmentShader = rename(shader.fragmentShader);
    const uniforms = { ...shader.uniforms };
    for (const key of Object.keys(uniforms)) {
      if (!key.startsWith('copy')) continue;
      shader.uniforms[`source${key.slice(4)}`] = uniforms[key];
      delete shader.uniforms[key];
    }
    shader.uniforms.batchSources = { value: this.sourceIDs };
    shader.vertexShader = `#define BATCH_PARTS ${this.parts.length}
      uniform float batchSources[BATCH_PARTS];\n${shader.vertexShader}`;

    if (!inherited) return;
    inherited.shader(shader, true);
    shader.vertexShader = shader.vertexShader
      .replace(/attribute vec4 materialCopy\w*;/g, '')
      .replace('vMaterialCopy = materialCopy;', 'vMaterialCopy = batchRead(0.);')
      .replace('vMaterialCopyU = materialCopyU;', 'vMaterialCopyU = batchRead(1.);')
      .replace('vMaterialCopyV = materialCopyV;', 'vMaterialCopyV = batchRead(2.);');
    shader.uniforms.batchData = { value: this.data };
    shader.uniforms.batchDataSize = { value: this.dataSize };
    shader.vertexShader = shader.vertexShader.replace('void main()', `
      vec4 batchRead(float column) {
        float offset = floor(getIndirectIndex(gl_DrawID) / float(BATCH_PARTS)) * 3. + column;
        return texture2D(batchData, (vec2(mod(offset, batchDataSize.x), floor(offset / batchDataSize.x)) + .5)
          / batchDataSize);
      }
      void main()`);
    shader.vertexShader = `uniform sampler2D batchData;\nuniform vec2 batchDataSize;\n${shader.vertexShader}`;
  }

  clear(): void {
    this.setVisibleCount(0);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.parts.forEach(part => part.geometry.dispose());
    this.material.dispose();
    this.data.dispose();
    this.appearance.dispose();
    this.registry.dispose();
  }
}
