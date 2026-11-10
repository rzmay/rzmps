import { copyMaterialEnvironment } from '../compositing/copyMaterialEnvironment';
import { applyMaterialCopies } from '../compositing/composite.utils';
import MeshBatch, { type AppearanceNodes } from './MeshBatch';
import evaluateDynamicNumber from '../../values/evaluateDynamicNumber';
import type { DynamicValue } from '../../values/dynamicValue.types';
import prepareTaggedSelection, { type TaggedSelection } from '../../core/tags/prepareTaggedSelection';
import selectByTags from '../../core/tags/selectByTags';
import selectByTagsGPU from '../../core/tags/selectByTagsGPU';
import type { TaggedValue } from '../../types/taggedValue.types';
import { rotateXYZ } from '../../simulation/gpu/transforms.utils';
import * as THREE from 'three';
import { attribute, materialNormal, materialColor, materialOpacity, materialRoughness,
  materialMetalness, float } from 'three/tsl';
import type { Node, WebGPURenderer } from 'three/webgpu';
import { positionLocal, positionGeometry } from 'three/tsl';
import Renderer, { type RendererOptions } from '../../core/Renderer';
import ParticleSystem from '../../core/ParticleSystem';
import Particle from '../../core/Particle';
import type { GPUParticleBufferState, GPUParticleRenderBufferState } from '../../simulation/gpu/Particle';

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
    private ownsCopyMaterial = false;
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
      normalNode: Node | null;
      roughnessNode: Node | null;
      metalnessNode: Node | null;
    }>();

    private materialEnvironmentState = new Map<THREE.Material, {
      envMap?: THREE.Texture | null;
      envMapIntensity?: number;
      envMapRotation?: THREE.Euler;
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
        this.batch = new MeshBatch(this.meshes, options.maxParticles ?? 10000, this.atlasOptions);
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
      const previous = this.mesh;
      const materials = Array.isArray(this.mesh.material) ? this.mesh.material.map(m => m.clone()) : this
        .mesh.material.clone();
      this.mesh = new THREE.Mesh(this.mesh.geometry.clone(), materials);
      this.mesh.geometry.setAttribute('instanceAlpha', this._alphaAttr);
      this.instancedMesh.geometry = this.mesh.geometry;
      this.instancedMesh.material = materials;
      this.preprocessMaterial(materials);
      if (this.ownsCopyMaterial) {
        for (const material of Array.isArray(previous.material) ? previous.material : [previous.material]) {
          this.materialNodeState.delete(material);
          material.dispose();
        }
        previous.geometry.dispose();
      }
      this.ownsCopyMaterial = true;
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
      super.reset();
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
      this.appearance?.trackMaterial(material);

      const nodeMaterial = material as THREE.Material & {
        colorNode?: Node | null;
        maskShadowNode?: Node | null;
        opacityNode?: Node | null;
        positionNode?: Node | null;
        normalNode?: Node | null;
        roughnessNode?: Node | null;
        metalnessNode?: Node | null;
      };
      if (!this.materialNodeState.has(material)) {
        // WebGPU copies these source-material properties into its internal node material.
        // Preserve explicit nulls so a mode reset rebuilds the ordinary material path.
        this.materialNodeState.set(material, {
          colorNode: nodeMaterial.colorNode ?? null,
          maskShadowNode: nodeMaterial.maskShadowNode ?? null,
          opacityNode: this.cpuOpacityNode,
          positionNode: nodeMaterial.positionNode ?? null,
          normalNode: nodeMaterial.normalNode ?? null,
          roughnessNode: nodeMaterial.roughnessNode ?? null,
          metalnessNode: nodeMaterial.metalnessNode ?? null,
        });
      }
      if (this.batch) {
        const source = this.batch.sourceAppearance();
        const inherited = this.appearance ? this.batch.cpuCopyAppearance(this.appearance) : undefined;
        const copies = inherited ? [source, inherited] : [source];
        this.applyCopies(material, copies, materialColor, materialOpacity);
        this.materialNodeState.set(material, {
          colorNode: nodeMaterial.colorNode ?? null, opacityNode: nodeMaterial.opacityNode ?? null,
          positionNode: null, maskShadowNode: null,
          normalNode: nodeMaterial.normalNode ?? null,
          roughnessNode: nodeMaterial.roughnessNode ?? null,
          metalnessNode: nodeMaterial.metalnessNode ?? null,
        });
        material.onBeforeCompile = shader => this.batch!.shader(shader, this.appearance);
        material.customProgramCacheKey = () =>
          `rzmps.batch:${this.batch!.parts.length}:${this.batch!.appearance.cacheKey}:${this.materialCopyCacheKey}`;
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
        material.customProgramCacheKey = () => `rzmps.mesh.copy:${this.materialCopyCacheKey}`;
        const copy = this.appearance.nodes(undefined, undefined, undefined, positionGeometry);
        this.applyCopies(material, [copy], materialColor, this.cpuOpacityNode.mul(materialOpacity));
        this.materialNodeState.set(material, { ...this.materialNodeState.get(material)!,
          colorNode: nodeMaterial.colorNode ?? null, opacityNode: nodeMaterial.opacityNode ?? null,
          normalNode: nodeMaterial.normalNode ?? null, roughnessNode: nodeMaterial.roughnessNode ?? null,
          metalnessNode: nodeMaterial.metalnessNode ?? null });
      }

      material.needsUpdate = true;
    }

    private applyCopies(material: THREE.Material, copies: AppearanceNodes[],
      color: Node<'vec3'>, opacity: Node<'float'>): void {
      applyMaterialCopies(material, copies, { color, opacity, normal: materialNormal,
        roughness: materialRoughness, metalness: materialMetalness });
    }

    private selectMesh(particle: Particle): number {
      return selectByTags(this.meshSelection, particle.tags, particle.id, this.meshIndex === undefined
        ? undefined : evaluateDynamicNumber(this.meshIndex, particle.time, particle.id));
    }

    private selectMeshGPU(particle: {
      id: Node<'uvec2'>; tagMask: Node<'uint'>; time: Node<'float'>; index: Node<'uint'>;
    }, system: ParticleSystem): Node<'float'> {
      const index = this.meshIndex === undefined ? undefined
        : this.evaluateDynamicGPU.number('meshIndex', () => this.meshIndex, particle.time, 0, particle.index);
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
        maskShadowNode: visible.greaterThan(0),
      });
      this.applyCopies(batch.material, copies, particle.color, particle.alpha.mul(visible));
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
        if (copy) this.applyCopies(material, [copy], particle.color.mul(materialColor),
          particle.alpha.mul(visible).mul(materialOpacity));
        else {
          nodeMaterial.colorNode = particle.color;
          nodeMaterial.opacityNode = particle.alpha.mul(visible);
        }
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
        normalNode?: Node | null;
        roughnessNode?: Node | null;
        metalnessNode?: Node | null;
        };
        const state = this.materialNodeState.get(material);
        nodeMaterial.positionNode = state?.positionNode ?? null;
        nodeMaterial.normalNode = state?.normalNode ?? null;
        nodeMaterial.roughnessNode = state?.roughnessNode ?? null;
        nodeMaterial.metalnessNode = state?.metalnessNode ?? null;
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
        copyMaterialEnvironment(material, original);
      });

      this.materialEnvironmentState.clear();
    }

    private updateSingleMaterialEnvironment(
      material: THREE.Material,
      system: ParticleSystem,
    ): void {
      // Reset can dispose a compiled material without replacing the material object.
      this.appearance?.trackMaterial(material);

      const envMaterial = material as THREE.Material & {
        envMap?: THREE.Texture | null;
        envMapIntensity?: number;
      };

      if (!('envMap' in envMaterial)) return;

      if (!this.materialEnvironmentState.has(material)) {
        this.materialEnvironmentState.set(material, {
          envMap: envMaterial.envMap,
          envMapIntensity: envMaterial.envMapIntensity,
          envMapRotation: (envMaterial as THREE.MeshStandardMaterial).envMapRotation?.clone(),
        });
      }

      const original = this.materialEnvironmentState.get(material);

      // A system capture takes precedence; copied surfaces otherwise supply their shared environment.
      if (system.useLiveCubemap) {
        copyMaterialEnvironment(material, {
          envMap: system.liveCubemap.map,
          envMapIntensity: system.liveCubemap.intensity,
          envMapRotation: original?.envMapRotation,
        });
        return;
      }

      copyMaterialEnvironment(material, this.appearance?.environment(this.materialTarget) ?? original);
    }
}

export default MeshRenderer;
