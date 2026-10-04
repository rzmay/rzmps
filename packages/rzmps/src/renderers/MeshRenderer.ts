import * as THREE from 'three';
import { attribute, float, uint } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { cos, positionLocal, sin, vec3 } from 'three/tsl';
import Renderer, { type RendererOptions } from '../Renderer';
import ParticleSystem from '../ParticleSystem';
import Particle from '../Particle';
import type { GPUParticleBufferState } from '../GPUParticle';

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
    mesh: THREE.Mesh;
    maxParticles: number;
    geometry: THREE.BufferGeometry,
    material: THREE.MeshStandardMaterial,
    materialOptions: THREE.MeshStandardMaterialParameters,
    castShadow: boolean,
    receiveShadow: boolean,
}

class MeshRenderer extends Renderer {
    mesh: THREE.Mesh;

    instances: THREE.InstancedMesh;

    castShadow: boolean = false;

    receiveShadow: boolean = false;

    private _alphaAttr: THREE.InstancedBufferAttribute;

    private dummy: THREE.Object3D;
    private identityMatrixCapacity = 0;

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

    _update(particles: Particle[], system: ParticleSystem): void {
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

    updateGPU(
      buffers: GPUParticleBufferState,
      system: ParticleSystem,
    ): void {
      this.instances.count = buffers.count;

      this.instances.castShadow = this.castShadow;
      this.instances.receiveShadow = this.receiveShadow;
      this.updateMaterialEnvironment(system);
      this.syncIdentityInstanceMatrices(buffers.count);
      this.applyGPUNodes(buffers);
    }

    destroy(): void {
        this.restoreMaterialEnvironment();
        this.instances.removeFromParent();
    }

    clear(): void {
      this.instances.count = 0;
    }

    private preprocessMaterial(
      material: THREE.Material<THREE.MaterialEventMap>
      | THREE.Material<THREE.MaterialEventMap>[]
    ) {
      if (Array.isArray(material)) return material.forEach((mat) => this.preprocessMaterial(mat));

      material.transparent = true;
      (material as THREE.Material & { opacityNode?: unknown }).opacityNode =
        attribute('instanceAlpha', 'float');
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

    private applyGPUNodes(buffers: GPUParticleBufferState): void {
      const particle = buffers.particle;
      const alive = buffers.alive.notEqual(uint(0)).select(float(1), float(0));
      const localPosition = rotateXYZ(positionLocal.mul(particle.scale).mul(alive), particle.rotation)
        .add(particle.position);
      const materials = Array.isArray(this.instances.material)
        ? this.instances.material
        : [this.instances.material];

      materials.forEach((material) => {
        const nodeMaterial = material as THREE.Material & {
          colorNode?: Node;
          opacityNode?: Node;
          positionNode?: Node;
        };

        nodeMaterial.positionNode = localPosition;
        nodeMaterial.colorNode = particle.color;
        nodeMaterial.opacityNode = particle.alpha.mul(alive);
        material.needsUpdate = true;
      });
    }

    private syncIdentityInstanceMatrices(count: number): void {
      if (this.identityMatrixCapacity >= count) return;

      this.dummy.position.set(0, 0, 0);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();

      for (let index = this.identityMatrixCapacity; index < count; index += 1) {
        this.instances.setMatrixAt(index, this.dummy.matrix);
        this._alphaAttr.setX(index, 1);
      }

      this.identityMatrixCapacity = count;
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
