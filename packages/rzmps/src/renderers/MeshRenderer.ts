import * as THREE from 'three';
import { attribute, float, uint } from 'three/tsl';
import type { Node, WebGPURenderer } from 'three/webgpu';
import { cos, positionLocal, sin, vec3 } from 'three/tsl';
import Renderer, { type RendererOptions } from '../Renderer';
import ParticleSystem from '../ParticleSystem';
import Particle from '../Particle';
import type { GPUParticleBufferState, GPUParticleRenderBufferState } from '../gpu/Particle';

/*
  * A mesh can be passed, including geometry and a material.
  * Alternatively, geometry can be passed with no material,
  * or material options for a MeshStandardMaterial can be passed in.
  * For flexibility's sake, a MeshStandardMaterial itself can also
  * be passed.
  * mesh will take precedent over geometry, material, and materialOptions.
  * material will take precedent over materialOptions.
*/
export interface MeshRendererOptions extends RendererOptions {
    /** Shared source geometry/material; takes precedence over geometry, material, and materialOptions. */
    mesh: THREE.Mesh;
    /** Allocated instance capacity; size it for the maximum visible population. Defaults to 10000. */
    maxParticles: number;
    /** Shared geometry used when mesh is omitted; defaults to sphere geometry. */
    geometry: THREE.BufferGeometry,
    /** Shared material used when mesh is omitted; takes precedence over materialOptions. */
    material: THREE.MeshStandardMaterial,
    /** Construction options for a default MeshStandardMaterial. */
    materialOptions: THREE.MeshStandardMaterialParameters,
    /** Enables instance shadow casting; false by default. */
    castShadow: boolean,
    /** Enables instance shadow reception; false by default. */
    receiveShadow: boolean,
}

/** Instances shared mesh geometry and material across particles; geometry complexity multiplies by visible population. */
class MeshRenderer extends Renderer {
    mesh: THREE.Mesh;

    instances: THREE.InstancedMesh;

    castShadow: boolean = false;

    receiveShadow: boolean = false;

    private _alphaAttr: THREE.InstancedBufferAttribute;

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

      this.mesh = options.mesh ?? new THREE.Mesh(
        options.geometry ?? new THREE.SphereGeometry(),
        options.material ?? new THREE.MeshStandardMaterial(options.materialOptions),
      );

      this.instances = new THREE.InstancedMesh(this.mesh.geometry, this.mesh.material, options.maxParticles ?? 10000);
      this.instances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.instances.frustumCulled = false;
      this.instances.setColorAt(0, new THREE.Color(1, 1, 1));

      this.castShadow = options.castShadow ?? this.castShadow;
      this.receiveShadow = options.receiveShadow ?? this.receiveShadow;

      this._alphaAttr = new THREE.InstancedBufferAttribute(
        new Float32Array(options.maxParticles ?? 10000),
        1
      );
      this.mesh.geometry.setAttribute(
        'instanceAlpha',
        this._alphaAttr,
      );

      this.dummy = new THREE.Object3D();

      this.preprocessMaterial(this.mesh.material);
    }

    setup(system: ParticleSystem): void {
      system.addRendererObject(this.instances);
    }

    private ensureInstanceCapacity(count: number): void {
      if (count <= this.instances.instanceMatrix.count) return;
      const capacity = 2 ** Math.ceil(Math.log2(count));
      this.instances.dispose();
      this.instances.instanceMatrix = new THREE.InstancedBufferAttribute(
        new Float32Array(capacity * 16), 16,
      ).setUsage(THREE.DynamicDrawUsage);
      this.instances.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      this._alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
      this.mesh.geometry.setAttribute('instanceAlpha', this._alphaAttr);
      this.identityMatrixCapacity = 0;
    }

    _update(particles: Particle[], system: ParticleSystem): void {
      this.ensureInstanceCapacity(particles.length);
      this.restoreCPUNodes();

      // CPU rendering owns the instance transforms until GPU mode restores
      // identity matrices and applies particle storage in the node material.
      this.identityMatrixCapacity = 0;
      this.instancesUseCPUTransforms = true;
      this.instances.geometry.indirect = null;
      this.instances.count = particles.length;

      this.instances.castShadow = this.castShadow;
      this.instances.receiveShadow = this.receiveShadow;
      this.updateMaterialEnvironment(system);

      particles.forEach((particle, i) => {
        this.dummy.position.copy(particle.position);
        this.dummy.rotation.setFromVector3(particle.rotation);
        this.dummy.scale.copy(particle.scale);

        this.dummy.updateMatrix();

        this.instances.setMatrixAt(i, this.dummy.matrix);
        this.instances.setColorAt(i, particle.color);

        this._alphaAttr.setX(i, particle.alpha);
      });

      if (this.instances.instanceColor) this.instances.instanceColor.needsUpdate = true;
      this.instances.instanceMatrix.needsUpdate = true;
      this._alphaAttr.needsUpdate = true;
    }

    protected _updateGPU(
      buffers: GPUParticleBufferState | GPUParticleRenderBufferState,
      system: ParticleSystem,
    ): void {
      this.ensureInstanceCapacity(buffers.count);
      this.prepareGPUVisibility(system);
      this.instances.count = buffers.count;

      this.instances.castShadow = this.castShadow;
      this.instances.receiveShadow = this.receiveShadow;
      this.updateMaterialEnvironment(system);
      if (this.gpuMaterialBuffer !== buffers) this.identityMatrixCapacity = 0;
      this.syncIdentityInstanceMatrices(buffers.count);
      if (this.instancesUseCPUTransforms) {
        this.instances.instanceMatrix.needsUpdate = true;
        this.instancesUseCPUTransforms = false;
      }
      this.applyGPUNodes(buffers, system);
    if ('bindIndirect' in buffers) {
      buffers.bindIndirect(this.instances.geometry, system.sceneRenderer as WebGPURenderer);
    }
    else this.instances.geometry.indirect = null;
    }

    destroy(): void {
        this.restoreCPUNodes();
        this.restoreMaterialEnvironment();
        this.instances.removeFromParent();
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
      this.instances.count = 0;
      this.instances.geometry.indirect = null;
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
      };

      material.needsUpdate = true;
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
      const visible = this.getGPUVisibilityNode(particle, system);
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
        nodeMaterial.colorNode = particle.color;
        nodeMaterial.opacityNode = particle.alpha.mul(visible);
        nodeMaterial.maskShadowNode = visible.greaterThan(0);
        material.needsUpdate = true;
      });

      this.gpuMaterialBuffer = buffers;
      this.gpuMaterialBufferVersion = buffers.version;
      this.gpuMaterialRendererVersion = this.version;
      this.gpuNodesApplied = true;
    }

    protected getGPUConfigurationSignature(): string {
      const materials = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
      return `${this.mesh.geometry.uuid}:${materials.map((material) => material.uuid).join(',')}`;
    }

    protected onGPUConfigurationChange(): void {
      this.restoreCPUNodes();
      this.instances.geometry = this.mesh.geometry;
      this.instances.material = this.mesh.material;
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
        this.instances.setMatrixAt(index, this.dummy.matrix);
        this.instances.setColorAt(index, this.gpuInstanceColor);
        this._alphaAttr.setX(index, 1);
      }

      this.identityMatrixCapacity = count;
      if (this.instances.instanceColor) this.instances.instanceColor.needsUpdate = true;
      this.instances.instanceMatrix.needsUpdate = true;
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

function rotateXYZ(position: Node<'vec3'>, rotation: Node<'vec3'>): Node<'vec3'> {
  const cx = cos(rotation.x);
  const sx = sin(rotation.x);
  const cy = cos(rotation.y);
  const sy = sin(rotation.y);
  const cz = cos(rotation.z);
  const sz = sin(rotation.z);

  const xRotated = vec3(
    position.x,
    position.y.mul(cx).sub(position.z.mul(sx)),
    position.y.mul(sx).add(position.z.mul(cx)),
  );
  const yRotated = vec3(
    xRotated.x.mul(cy).add(xRotated.z.mul(sy)),
    xRotated.y,
    xRotated.z.mul(cy).sub(xRotated.x.mul(sy)),
  );

  return vec3(
    yRotated.x.mul(cz).sub(yRotated.y.mul(sz)),
    yRotated.x.mul(sz).add(yRotated.y.mul(cz)),
    yRotated.z,
  );
}

export default MeshRenderer;
