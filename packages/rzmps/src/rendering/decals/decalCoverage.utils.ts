import * as THREE from 'three';
import { positionGeometry, vec4 } from 'three/tsl';
import { PARTICLE_RENDERER_OBJECT_KEY } from '../renderers/LiveCubemap';

// Reserved internally for decal union coverage. Other stencil consumers must leave this bit untouched.
const coverageBit = 0x80;
const scopes = new WeakMap<THREE.Object3D, { mesh: THREE.Mesh; users: number }>();

/** One masked reset draw per scene/pass; depth, color and all other stencil bits remain untouched. */
export function retainDecalCoverage(parent: THREE.Object3D): () => void {
  let scope = scopes.get(parent);

  if (!scope) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      colorWrite: false,
      depthWrite: false,
      depthTest: false,
      stencilWrite: true,
      stencilWriteMask: coverageBit,
      stencilFuncMask: coverageBit,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilZPass: THREE.ZeroStencilOp,
    });
    Object.assign(material, { vertexNode: vec4(positionGeometry.xy, 0, 1) });
    material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        'gl_Position = vec4(position.xy, 0.0, 1.0);',
      );
    };
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'Decal coverage reset';
    mesh.renderOrder = -2;
    mesh.frustumCulled = false;
    mesh.userData[PARTICLE_RENDERER_OBJECT_KEY] = true;
    mesh.onBeforeRender = renderer => {
      const target = renderer.getRenderTarget();
      const stencil = target
        ? target.stencilBuffer
        : 'stencil' in renderer
          ? renderer.stencil
          : renderer.getContext().getContextAttributes()?.stencil;
      if (!stencil) throw new Error('DecalRenderer.unionCoverage requires a stencil-enabled framebuffer.');
    };
    parent.add(mesh);
    scope = { mesh, users: 0 };
    scopes.set(parent, scope);
  }

  scope.users++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--scope!.users) return;
    scope!.mesh.removeFromParent();
    scope!.mesh.geometry.dispose();
    (scope!.mesh.material as THREE.Material).dispose();
    scopes.delete(parent);
  };
}

/** Test-and-set only the reserved bit. Discarded/occluded fragments never claim coverage. */
export function applyDecalCoverage(material: THREE.Material): void {
  material.stencilWrite = true;
  material.stencilRef = coverageBit;
  material.stencilFuncMask = material.stencilWriteMask = coverageBit;
  material.stencilFunc = THREE.NotEqualStencilFunc;
  material.stencilFail = material.stencilZFail = THREE.KeepStencilOp;
  material.stencilZPass = THREE.ReplaceStencilOp;
}
