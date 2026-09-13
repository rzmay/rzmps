import * as THREE from 'three';
import { attribute } from 'three/src/nodes/core/AttributeNode.js';
import Renderer, { RendererOptions } from '../Renderer';
import ParticleSystem from '../ParticleSystem';
import Particle from '../Particle';

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

    _update(particles: Particle[]): void {
      this.instances.count = particles.length;

      this.instances.castShadow = this.castShadow;
      this.instances.receiveShadow = this.receiveShadow;

      particles.forEach((particle, i) => {
        this.dummy.position.set(...particle.position.toArray());
        this.dummy.rotation.set(...particle.rotation.toArray());
        this.dummy.scale.set(...particle.scale.toArray());

        this.dummy.updateMatrix();

        this.instances.setMatrixAt(i, this.dummy.matrix);
        this.instances.setColorAt(i, particle.color);

        this._alphaAttr.setX(i, particle.alpha);
      });

      if (this.instances.instanceColor) this.instances.instanceColor.needsUpdate = true;
      this.instances.instanceMatrix.needsUpdate = true;
      this._alphaAttr.needsUpdate = true;
    }

    destroy(): void
    {
        this.instances.removeFromParent();
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
}

export default MeshRenderer;
