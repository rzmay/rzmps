import MeshBatch, { type AppearanceNodes } from './MeshBatch';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import type { DynamicValue } from '../types/DynamicValue';
import prepareTaggedSelection, { type TaggedSelection } from '../helpers/prepareTaggedSelection';
import selectByTags from '../helpers/selectByTags';
import selectByTagsGPU from '../helpers/selectByTagsGPU';
import type { TaggedValue } from '../types/TaggedValue';
import rotateXYZ from '../helpers/rotateParticleGPU';
import type Appearance from '../material-copy/Appearance';
import * as THREE from 'three';
import { attribute, materialNormal, positionView, materialColor, materialOpacity, materialRoughness,
  materialMetalness, float } from 'three/tsl';
import type { Node, WebGPURenderer } from 'three/webgpu';
import { positionLocal, positionGeometry } from 'three/tsl';
import Renderer, { type RendererOptions } from '../Renderer';
import ParticleSystem from '../ParticleSystem';
import Particle from '../Particle';
import type { GPUParticleBufferState, GPUParticleRenderBufferState } from '../gpu/Particle';

export interface MeshRendererOptions extends RendererOptions {
    /** One source mesh or static mesh templates; takes precedence over geometry and material options. */
    mesh: TaggedValue<THREE.Mesh>;
    /** Geometry choice; omission chooses a stable random mesh per particle. */
    meshIndex?: DynamicValue<number>;
    /** Allocated instance capacity; size it for the maximum visible population. Defaults to 10000. */
    maxParticles: number;
    /** One geometry or static variants sharing the material; defaults to sphere geometry. */
    geometry: TaggedValue<THREE.BufferGeometry>,
    /** Shared material used when mesh is omitted; takes precedence over materialOptions. */
    material: THREE.MeshStandardMaterial,
    /** Construction options for a default MeshStandardMaterial. */
    materialOptions: THREE.MeshStandardMaterialParameters,
    /** Enables instance shadow casting; false by default. */
    castShadow: boolean,
    /** Enables instance shadow reception; false by default. */
    receiveShadow: boolean,
}

/** Instances a single source mesh, or batches multiple mesh variants with atlas-backed material factors. */
class MeshRenderer extends Renderer {
    mesh: THREE.Mesh;
    /** Original resource tree, retained for tooling and serialization. */
    readonly meshSource: TaggedValue<THREE.Mesh | THREE.BufferGeometry>;

    /** Particle capacity, independent of the number of batched geometry parts. */
    get maxParticles(): number {
      return this.batch ? Math.floor(this.batch.mesh.maxInstanceCount / this.batch.parts.length)
        : this.instancedMesh.instanceMatrix.count;
    }

    /** Single geometry uses instancing; multiple source meshes use batching. */
    get instances(): THREE.InstancedMesh | THREE.BatchedMesh {
      return this.batch?.mesh ?? this.instancedMesh;
    }

    /** Source templates used by the batched path. Source transforms are not particle transforms. */
    readonly meshes: readonly THREE.Mesh[];
    meshIndex?: DynamicValue<number>;
    private readonly meshSelection: TaggedSelection<THREE.Mesh | THREE.BufferGeometry>;

    override get selectionTags(): readonly string[] {
      return this.meshSelection?.tags ?? [];
    }

    private batch?: MeshBatch;
    private instancedMesh!: THREE.InstancedMesh;

    castShadow: boolean = false;

    receiveShadow: boolean = false;

    private _alphaAttr!: THREE.InstancedBufferAttribute;

    private dummy: THREE.Object3D;
    private identityMatrixCapacity = 0;
    private instancesUseCPUTransforms = false;
    private gpuMaterialBuffer?: GPUParticleBufferState | GPUParticleRenderBufferState;
    private gpuMaterialBufferVersion = -1;
    private gpuMaterialRendererVersion = -1;
    private gpuNodesApplied = false;
    private readonly cpuOpacityNode = attribute('instanceAlpha', 'float');
    private readonly gpuInstanceColor = new THREE.Color(1, 1, 1);

    private materialNodeState = new Map<THREE.Material, {
      colorNode: Node | null;
      maskShadowNode: Node | null;
      opacityNode: Node | null;
      positionNode: Node | null;
    }>();

    private materialEnvironmentState = new Map<THREE.Material, {
      envMap?: THREE.Texture | null;
      envMapIntensity?: number;
    }>();

    constructor(options: Partial<MeshRendererOptions> = {}) {
      super(options);

      if (options.maxParticles !== undefined && (!Number.isSafeInteger(options.maxParticles)
        || options.maxParticles < 1)) throw new RangeError('maxParticles must be a positive integer.');
      this.meshSource = options.mesh ?? options.geometry ?? new THREE.SphereGeometry();
      this.meshSelection = prepareTaggedSelection<THREE.Mesh | THREE.BufferGeometry>(
        this.meshSource,
        (value): value is THREE.Mesh | THREE.BufferGeometry => options.mesh
          ? value instanceof THREE.Mesh : value instanceof THREE.BufferGeometry,
      );
      const material = options.mesh ? undefined
        : options.material ?? new THREE.MeshStandardMaterial(options.materialOptions);
      this.meshes = this.meshSelection.values.map(source => source instanceof THREE.Mesh
        ? source : new THREE.Mesh(source, material));
      this.mesh = this.meshes[0];
      this.meshIndex = options.meshIndex;
      this.dummy = new THREE.Object3D();
      this.castShadow = options.castShadow ?? this.castShadow;
      this.receiveShadow = options.receiveShadow ?? this.receiveShadow;

      if (this.meshes.length > 1) {
        this.batch = new MeshBatch(this.meshes, options.maxParticles ?? 10000);
        this.preprocessMaterial(this.batch.material);
        return;
      }

      this.instancedMesh = new THREE.InstancedMesh(this.mesh.geometry, this.mesh.material,
        options.maxParticles ?? 10000);
      this.instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.instancedMesh.frustumCulled = false;
      this.instancedMesh.setColorAt(0, new THREE.Color(1, 1, 1));

      this._alphaAttr = new THREE.InstancedBufferAttribute(
        new Float32Array(options.maxParticles ?? 10000),
        1
      );
      this.mesh.geometry.setAttribute(
        'instanceAlpha',
        this._alphaAttr,
      );

      this.preprocessMaterial(this.mesh.material);
    }

    protected onMaterialCopyChange(): void {
      if (this.batch) {
        this.preprocessMaterial(this.batch.material);
        return;
      }

      // Copying owns its shader changes; collision surfaces remain untouched.
      const materials = Array.isArray(this.mesh.material) ? this.mesh.material.map(m => m.clone()) : this
        .mesh.material.clone();
      this.mesh = new THREE.Mesh(this.mesh.geometry.clone(), materials);
      this.mesh.geometry.setAttribute('instanceAlpha', this._alphaAttr);
      this.instancedMesh.geometry = this.mesh.geometry;
      this.instancedMesh.material = materials;
      this.preprocessMaterial(materials);
    }

    setup(system: ParticleSystem): void {
      system.addRendererObject(this.instances);
    }

    private ensureInstanceCapacity(count: number): void {
      if (count <= this.instancedMesh.instanceMatrix.count) return;
      const capacity = 2 ** Math.ceil(Math.log2(count));
      this.instancedMesh.dispose();
      this.instancedMesh.instanceMatrix = new THREE.InstancedBufferAttribute(
        new Float32Array(capacity * 16), 16,
      ).setUsage(THREE.DynamicDrawUsage);
      this.instancedMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      this._alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
      this.mesh.geometry.setAttribute('instanceAlpha', this._alphaAttr);
      this.identityMatrixCapacity = 0;
    }

    _update(particles: Particle[], system: ParticleSystem): void {
      if (this.batch) {
        this.restoreCPUNodes();
        this.batch.sync(system.sceneRenderer);
        this.batch.updateCPU(particles, particle => this.selectMesh(particle));
        this.instances.castShadow = this.castShadow;
        this.instances.receiveShadow = this.receiveShadow;
        this.updateMaterialEnvironment(system);
        return;
      }

      const selectedParticles = this.meshSelection.structured
        ? particles.filter(particle => this.selectMesh(particle) >= 0) : particles;
      this.ensureInstanceCapacity(selectedParticles.length);
      this.appearance?.attributes(this.mesh.geometry, selectedParticles, true);
      this.restoreCPUNodes();

      // CPU rendering owns the instance transforms until GPU mode restores
      // identity matrices and applies particle storage in the node material.
      this.identityMatrixCapacity = 0;
      this.instancesUseCPUTransforms = true;
      this.instancedMesh.geometry.indirect = null;
      this.instancedMesh.count = selectedParticles.length;

      this.instancedMesh.castShadow = this.castShadow;
      this.instancedMesh.receiveShadow = this.receiveShadow;
      this.updateMaterialEnvironment(system);

      selectedParticles.forEach((particle, i) => {
        this.dummy.position.copy(particle.position);
        this.dummy.rotation.setFromVector3(particle.rotation);
        this.dummy.scale.copy(particle.scale);

        this.dummy.updateMatrix();

        this.instancedMesh.setMatrixAt(i, this.dummy.matrix);
        this.instancedMesh.setColorAt(i, particle.color);

        this._alphaAttr.setX(i, particle.alpha);
      });

      if (this.instancedMesh.instanceColor) this.instancedMesh.instanceColor.needsUpdate = true;
      this.instancedMesh.instanceMatrix.needsUpdate = true;
      this._alphaAttr.needsUpdate = true;
    }

    protected _updateGPU(
      buffers: GPUParticleBufferState | GPUParticleRenderBufferState,
      system: ParticleSystem,
    ): void {
      if (this.batch) {
        this.prepareGPUVisibility(system);
        this.batch.sync(system.sceneRenderer);
        this.batch.updateGPU(buffers.count);
        this.instances.castShadow = this.castShadow;
        this.instances.receiveShadow = this.receiveShadow;
        this.updateMaterialEnvironment(system);
        this.applyBatchGPUNodes(buffers, system);
        return;
      }

      this.ensureInstanceCapacity(buffers.count);
      this.prepareGPUVisibility(system);
      this.instancedMesh.count = buffers.count;

      this.instancedMesh.castShadow = this.castShadow;
      this.instancedMesh.receiveShadow = this.receiveShadow;
      this.updateMaterialEnvironment(system);
      if (this.gpuMaterialBuffer !== buffers) this.identityMatrixCapacity = 0;
      this.syncIdentityInstanceMatrices(buffers.count);
      if (this.instancesUseCPUTransforms) {
        this.instancedMesh.instanceMatrix.needsUpdate = true;
        this.instancesUseCPUTransforms = false;
      }
      this.applyGPUNodes(buffers, system);
      if ('bindIndirect' in buffers) {
        buffers.bindIndirect(this.instancedMesh.geometry, system.sceneRenderer as WebGPURenderer);
      } else {
        this.instancedMesh.geometry.indirect = null;
      }
    }

    destroy(): void {
        this.restoreCPUNodes();
        if (this.batch) {
          this.disposeMaterialCopy();
          this.restoreMaterialEnvironment();
          this.batch.dispose();
          return;
        }
        if (this.appearance) {
          const materials = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
          materials.forEach(m => m.dispose());
          this.mesh.geometry.dispose();
        }
        this.disposeMaterialCopy();
        this.restoreMaterialEnvironment();
        this.instancedMesh.removeFromParent();
    }

    override reset(): void {
      super.reset();
      this.restoreCPUNodes();
      const materials = Array.isArray(this.instances.material)
        ? this.instances.material
        : [this.instances.material];
      // Evict Three.js's cached WebGPU render object before its particle buffers are cleared.
      materials.forEach((material) => material.dispose());
    }

    clear(): void {
      this.restoreCPUNodes();
      if (this.batch) {
        this.batch.clear();
        return;
      }
      this.instancedMesh.count = 0;
      this.instancedMesh.geometry.indirect = null;
      this.identityMatrixCapacity = 0;
      this.gpuMaterialBuffer = undefined;
      this.gpuMaterialBufferVersion = -1;
      this.gpuMaterialRendererVersion = -1;
    }

    private preprocessMaterial(
      material: THREE.Material<THREE.MaterialEventMap>
      | THREE.Material<THREE.MaterialEventMap>[]
    ) {
      if (Array.isArray(material)) return material.forEach((mat) => this.preprocessMaterial(mat));

      material.transparent = true;
      const nodeMaterial = material as THREE.Material & {
        colorNode?: Node | null;
        maskShadowNode?: Node | null;
        opacityNode?: Node | null;
        positionNode?: Node | null;
      };
      if (!this.materialNodeState.has(material)) {
        // WebGPU copies these source-material properties into its internal node material.
        // Preserve explicit nulls so a mode reset rebuilds the ordinary material path.
        this.materialNodeState.set(material, {
          colorNode: nodeMaterial.colorNode ?? null,
          maskShadowNode: nodeMaterial.maskShadowNode ?? null,
          opacityNode: this.cpuOpacityNode,
          positionNode: nodeMaterial.positionNode ?? null,
        });
      }
      if (this.batch) {
        const source = this.batch.sourceAppearance();
        const inherited = this.appearance ? this.batch.cpuCopyAppearance(this.appearance) : undefined;
        const copies = inherited ? [source, inherited] : [source];
        nodeMaterial.colorNode = copies.reduce<Node<'vec3'>>((color, copy) => color.mul(copy.color), materialColor);
        nodeMaterial.opacityNode = copies.reduce<Node<'float'>>(
          (alpha, copy) => alpha.mul(copy.alpha), materialOpacity,
        );
        this.setAppearancePhysicalNodes(material, copies);
        this.materialNodeState.set(material, {
          colorNode: nodeMaterial.colorNode ?? null, opacityNode: nodeMaterial.opacityNode ?? null,
          positionNode: null, maskShadowNode: null,
        });
        material.onBeforeCompile = shader => this.batch!.shader(shader, this.appearance);
        material.customProgramCacheKey = () => `rzmps.batch:${this.batch!.parts.length}:${!!this.appearance}`;
        material.needsUpdate = true;
        return;
      }

      nodeMaterial.opacityNode = this.cpuOpacityNode;
      material.onBeforeCompile = (shader) => {
        shader.vertexShader = `
attribute float instanceAlpha;
varying float vInstanceAlpha;
${shader.vertexShader}
        `.replace(
          '#include <begin_vertex>',
          `
#include <begin_vertex>
vInstanceAlpha = instanceAlpha;`
        );

        shader.fragmentShader = `
varying float vInstanceAlpha;
${shader.fragmentShader}
        `.replace(
          '#include <opaque_fragment>',
          `
#include <opaque_fragment>
gl_FragColor.a *= vInstanceAlpha;`
        );
        this.appearance?.shader(shader, true);
      };
      if (this.appearance) {
        material.customProgramCacheKey = () => 'rzmps.mesh.copy';
        const copy = this.appearance.nodes(undefined, undefined, undefined, positionGeometry);
        nodeMaterial.colorNode = materialColor.mul(copy.color);
        nodeMaterial.opacityNode = this.cpuOpacityNode.mul(materialOpacity).mul(copy.alpha);
        this.setCopiedPhysicalNodes(material, copy);
        this.materialNodeState.set(material, { ...this.materialNodeState.get(material)!,
          colorNode: nodeMaterial.colorNode, opacityNode: nodeMaterial.opacityNode });
      }

      material.needsUpdate = true;
    }

    private setCopiedPhysicalNodes(material: THREE.Material, copy: ReturnType<Appearance['nodes']>): void {
      this.setAppearancePhysicalNodes(material, [copy]);
    }

    private setAppearancePhysicalNodes(material: THREE.Material, copies: AppearanceNodes[]): void {
      let normal: Node<'vec3'> = materialNormal;
      let roughness: Node<'float'> = materialRoughness;
      let metalness: Node<'float'> = materialMetalness;

      for (const copy of copies) {
        const q0 = positionView.dFdx();
        const q1 = positionView.dFdy();
        const st0 = copy.normalUV.dFdx();
        const st1 = copy.normalUV.dFdy();
        const tangent = q0.mul(st1.y).sub(q1.mul(st0.y));
        const bitangent = q1.mul(st0.x).sub(q0.mul(st1.x));
        const scale = tangent.dot(tangent).max(bitangent.dot(bitangent)).max(1e-12).sqrt().reciprocal();
        const detail = tangent.mul(copy.normal.x).add(bitangent.mul(copy.normal.y)).mul(scale);
        normal = detail.add(normal.mul(copy.normal.z)).normalize();
        roughness = roughness.mul(copy.roughness);
        metalness = metalness.mul(copy.metalness);
      }
      Object.assign(material, { roughnessNode: roughness, metalnessNode: metalness, normalNode: normal });
    }

    private selectMesh(particle: Particle): number {
      return selectByTags(this.meshSelection, particle.tags, particle.id, this.meshIndex === undefined
        ? undefined : evaluateDynamicNumber(this.meshIndex, particle.time, particle.id));
    }

    private selectMeshGPU(particle: {
      id: Node<'uvec2'>; tagMask: Node<'uint'>; time: Node<'float'>; index: Node<'uint'>;
    }, system: ParticleSystem): Node<'float'> {
      const index = this.meshIndex === undefined ? undefined
        : this.gpuParameters.number('meshIndex', () => this.meshIndex, particle.time, 0, particle.index);
      return selectByTagsGPU(this.meshSelection, particle.tagMask, tag => system.getGPURendererTagMask([tag]) ?? 0,
        particle.id.x.bitXor(particle.id.y), index);
    }

    private applyBatchGPUNodes(
      buffers: GPUParticleBufferState | GPUParticleRenderBufferState,
      system: ParticleSystem,
    ): void {
      const batch = this.batch!;
      if (this.gpuMaterialBuffer === buffers && this.gpuMaterialBufferVersion === buffers.version
        && this.gpuMaterialRendererVersion === this.version) return;

      // BatchedMesh addresses draws, not instances. Candidate parts share one particle slot.
      const particle = buffers.storage.createParticle(batch.slot);
      const index = this.selectMeshGPU(particle, system);
      const visible = this.getGPUVisibilityNode(particle, system).mul(batch.variant.equal(index).select(1, 0));
      const source = batch.sourceAppearance();
      const inherited = this.appearance?.nodes(particle.materialCopy, particle.materialCopyU,
        particle.materialCopyV, positionGeometry);
      const copies = inherited ? [source, inherited] : [source];
      Object.assign(batch.material, {
        positionNode: rotateXYZ(positionGeometry.mul(particle.scale).mul(this.getGPUScaleMultiplierNode()),
          particle.rotation).mul(visible).add(particle.position),
        colorNode: copies.reduce<Node<'vec3'>>((color, copy) => color.mul(copy.color), particle.color),
        opacityNode: copies.reduce<Node<'float'>>((alpha, copy) => alpha.mul(copy.alpha), particle.alpha.mul(visible)),
        maskShadowNode: visible.greaterThan(0),
      });
      this.setAppearancePhysicalNodes(batch.material, copies);
      batch.material.needsUpdate = true;
      this.gpuMaterialBuffer = buffers;
      this.gpuMaterialBufferVersion = buffers.version;
      this.gpuMaterialRendererVersion = this.version;
      this.gpuNodesApplied = true;
    }

    private applyGPUNodes(
      buffers: GPUParticleBufferState | GPUParticleRenderBufferState,
      system: ParticleSystem,
    ): void {
      if (
        this.gpuMaterialBuffer === buffers
        && this.gpuMaterialBufferVersion === buffers.version
        && this.gpuMaterialRendererVersion === this.version
      ) return;

      const particle = buffers.particle;
      const selected = this.meshSelection.structured
        ? this.selectMeshGPU(particle, system).greaterThanEqual(0).select(1, 0) : float(1);
      const visible = this.getGPUVisibilityNode(particle, system).mul(selected);
      const scaleMultiplier = this.getGPUScaleMultiplierNode();
      const localPosition = rotateXYZ(
        positionLocal.mul(particle.scale).mul(visible).mul(scaleMultiplier),
        particle.rotation,
      )
        .add(particle.position);
      const materials = Array.isArray(this.instances.material)
        ? this.instances.material
        : [this.instances.material];

      materials.forEach((material) => {
        const nodeMaterial = material as THREE.Material & {
          colorNode?: Node;
          maskShadowNode?: Node;
          opacityNode?: Node;
          positionNode?: Node;
        };

        nodeMaterial.positionNode = localPosition;
        const copy = this.appearance?.nodes(particle.materialCopy, particle.materialCopyU,
          particle.materialCopyV, positionGeometry);
        nodeMaterial.colorNode = copy ? particle.color.mul(materialColor).mul(copy.color) : particle.color;
        nodeMaterial.opacityNode = copy ? particle.alpha.mul(visible).mul(materialOpacity).mul(copy.alpha)
          : particle.alpha.mul(visible);
        if (copy) this.setCopiedPhysicalNodes(material, copy);
        nodeMaterial.maskShadowNode = visible.greaterThan(0);
        material.needsUpdate = true;
      });

      this.gpuMaterialBuffer = buffers;
      this.gpuMaterialBufferVersion = buffers.version;
      this.gpuMaterialRendererVersion = this.version;
      this.gpuNodesApplied = true;
    }

    protected getGPUConfigurationSignature(): string {
      if (this.batch) {
        return `${String(this.meshIndex)}:${this.batch.mesh.geometry.uuid}`;
      }
      const materials = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
      return `${this.mesh.geometry.uuid}:${materials.map((material) => material.uuid).join(',')}`;
    }

    protected onGPUConfigurationChange(): void {
      this.restoreCPUNodes();
      if (this.batch) {
        this.preprocessMaterial(this.batch.material);
        return;
      }
      this.instancedMesh.geometry = this.mesh.geometry;
      this.instancedMesh.material = this.mesh.material;
      this.preprocessMaterial(this.mesh.material);
      this.gpuMaterialBuffer = undefined;
      this.gpuMaterialBufferVersion = -1;
      this.gpuMaterialRendererVersion = -1;
    }

    private restoreCPUNodes(): void {
      if (!this.gpuNodesApplied) return;

      const materials = Array.isArray(this.instances.material)
        ? this.instances.material
        : [this.instances.material];
      materials.forEach((material) => {
        const nodeMaterial = material as THREE.Material & {
          colorNode?: Node | null;
          maskShadowNode?: Node | null;
          opacityNode?: Node | null;
          positionNode?: Node | null;
        };
        const state = this.materialNodeState.get(material);
        nodeMaterial.positionNode = state?.positionNode ?? null;
        nodeMaterial.colorNode = state?.colorNode ?? null;
        nodeMaterial.opacityNode = state?.opacityNode ?? this.cpuOpacityNode;
        nodeMaterial.maskShadowNode = state?.maskShadowNode ?? null;
        material.needsUpdate = true;
      });

      this.gpuNodesApplied = false;
      if (this.batch) this.preprocessMaterial(this.batch.material);
      this.gpuMaterialBuffer = undefined;
      this.gpuMaterialBufferVersion = -1;
      this.gpuMaterialRendererVersion = -1;
    }

    private syncIdentityInstanceMatrices(count: number): void {
      if (this.identityMatrixCapacity >= count) return;

      this.dummy.position.set(0, 0, 0);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();

      for (let index = this.identityMatrixCapacity; index < count; index += 1) {
        this.instancedMesh.setMatrixAt(index, this.dummy.matrix);
        this.instancedMesh.setColorAt(index, this.gpuInstanceColor);
        this._alphaAttr.setX(index, 1);
      }

      this.identityMatrixCapacity = count;
      if (this.instancedMesh.instanceColor) this.instancedMesh.instanceColor.needsUpdate = true;
      this.instancedMesh.instanceMatrix.needsUpdate = true;
      this._alphaAttr.needsUpdate = true;
    }

    private updateMaterialEnvironment(system: ParticleSystem): void {
      const materials = Array.isArray(this.instances.material)
        ? this.instances.material
        : [this.instances.material];

      materials.forEach((material) => this.updateSingleMaterialEnvironment(material, system));
    }

    private restoreMaterialEnvironment(): void {
      this.materialEnvironmentState.forEach((original, material) => {
        const envMaterial = material as THREE.Material & {
          envMap?: THREE.Texture | null;
          envMapIntensity?: number;
        };

        envMaterial.envMap = original.envMap;
        envMaterial.envMapIntensity = original.envMapIntensity;
        material.needsUpdate = true;
      });

      this.materialEnvironmentState.clear();
    }

    private updateSingleMaterialEnvironment(
      material: THREE.Material,
      system: ParticleSystem,
    ): void {
      const envMaterial = material as THREE.Material & {
        envMap?: THREE.Texture | null;
        envMapIntensity?: number;
      };

      if (!('envMap' in envMaterial)) return;

      if (!this.materialEnvironmentState.has(material)) {
        this.materialEnvironmentState.set(material, {
          envMap: envMaterial.envMap,
          envMapIntensity: envMaterial.envMapIntensity,
        });
      }

      const original = this.materialEnvironmentState.get(material);

      if (system.useLiveCubemap) {
        const nextMap = system.liveCubemap.map ?? null;

        if (
          envMaterial.envMap !== nextMap
          || envMaterial.envMapIntensity !== system.liveCubemap.intensity
        ) {
          envMaterial.envMap = nextMap;
          envMaterial.envMapIntensity = system.liveCubemap.intensity;
          material.needsUpdate = true;
        }

        return;
      }

      if (!original) return;

      if (
        envMaterial.envMap !== original.envMap
        || envMaterial.envMapIntensity !== original.envMapIntensity
      ) {
        envMaterial.envMap = original.envMap;
        envMaterial.envMapIntensity = original.envMapIntensity;
        material.needsUpdate = true;
      }
    }
}


export default MeshRenderer;
