import type * as THREE from 'three';
import type { Node } from 'three/webgpu';
import {
  attribute,
  float,
  materialColor,
  materialMetalness,
  materialNormal,
  materialOpacity,
  materialRoughness,
  normalViewGeometry,
  positionGeometry,
  texture,
  vec2,
  vec3,
} from 'three/tsl';
import type {
  GPUMaterialChannels,
  MaterialChannels,
  MaterialCompositeCallback,
  MaterialCompositeGPUCallback,
} from './composite.utils';

type SurfaceMaterial = THREE.Material & {
  vertexColors: boolean;
  colorNode?: Node | null;
  opacityNode?: Node | null;
  normalNode?: Node | null;
  roughnessNode?: Node | null;
  metalnessNode?: Node | null;
};
const originalHooks = new WeakMap<THREE.Material, THREE.Material['onBeforeCompile']>();
const originalProgramKeys = new WeakMap<THREE.Material, THREE.Material['customProgramCacheKey']>();
let revision = 0;
const originalNodes = new WeakMap<THREE.Material, Partial<SurfaceMaterial>>();

/**
 * Source-less composition for reconstructed surfaces and receiver-local decal geometry.
 * receiverLocal exposes the raw position attribute before Three.js applies the batch's receiver transform.
 */
export function applySurfaceMaterial(
  material: THREE.Material,
  particleColors: boolean,
  gpu?: MaterialCompositeGPUCallback,
  cpu?: MaterialCompositeCallback,
  receiverLocal = false,
): void {
  const target = material as SurfaceMaterial;
  let original = originalNodes.get(material);
  if (!original) {
    original = {
      colorNode: target.colorNode ?? null,
      opacityNode: target.opacityNode ?? null,
      normalNode: target.normalNode ?? null,
      roughnessNode: target.roughnessNode ?? null,
      metalnessNode: target.metalnessNode ?? null,
    };
    originalNodes.set(material, original);
  }
  Object.assign(target, original);
  target.vertexColors = particleColors;
  if (gpu) {
    const velocity = attribute('surfaceVelocity', 'vec4');
    const vorticity = attribute('surfaceVorticity', 'vec4');
    const color = particleColors ? attribute('color', 'vec3') : vec3(1);
    const dest: GPUMaterialChannels = {
      color: ((original.colorNode as Node<'vec3'> | null) ?? materialColor.rgb).mul(color),
      opacity:
        (original.opacityNode as Node<'float'> | null) ??
        (receiverLocal && (material as THREE.MeshStandardMaterial).map
          ? materialOpacity.mul(texture((material as THREE.MeshStandardMaterial).map!).a)
          : materialOpacity),
      normal: (original.normalNode as Node<'vec3'> | null) ?? materialNormal,
      roughness: (original.roughnessNode as Node<'float'> | null) ?? materialRoughness,
      metalness: (original.metalnessNode as Node<'float'> | null) ?? materialMetalness,
    };
    const output = {
      ...dest,
      ...gpu(dest, dest, {
        geometricNormal: normalViewGeometry,
        destMapAlpha: float(1),
        sourceUV: vec2(0),
        destUV: vec2(0),
        sampleSource: channel => dest[channel],
        sampleDest: channel => dest[channel],
        receiverPositionLocal: receiverLocal ? positionGeometry : undefined,
        surfaceVelocity: receiverLocal ? undefined : velocity.xyz,
        surfaceSpeed: receiverLocal ? undefined : velocity.xyz.length(),
        surfaceSupport: receiverLocal ? undefined : velocity.w,
        surfaceVorticity: receiverLocal ? undefined : vorticity.xyz,
        surfaceVorticityMagnitude: receiverLocal ? undefined : vorticity.xyz.length(),
        surfaceDeformation: receiverLocal ? undefined : vorticity.w,
      }),
    };
    // Composite color already includes particle color, so do not multiply it again in Three's vertex-color stage.
    target.vertexColors = false;
    Object.assign(target, {
      colorNode: output.color,
      opacityNode: output.opacity,
      normalNode: output.normal,
      roughnessNode: output.roughness,
      metalnessNode: output.metalness,
    });
  }

  // Equivalent GLSL attributes for material use with a CPU-owned/exported surface geometry.
  // Reconstruction itself remains native WebGPU; this does not introduce a CPU solver or readback path.
  if (!originalHooks.has(material)) originalHooks.set(material, material.onBeforeCompile);
  if (!originalProgramKeys.has(material)) originalProgramKeys.set(material, material.customProgramCacheKey);
  const programKey = originalProgramKeys.get(material)!;
  const version = ++revision;
  material.customProgramCacheKey = cpu ? () => `${programKey.call(material)}:surface:${version}` : programKey;
  const shaderHook = originalHooks.get(material)!;
  material.onBeforeCompile = shaderHook;
  if (cpu)
    material.onBeforeCompile = (shader, renderer) => {
      shaderHook.call(material, shader, renderer);
      const functions = new Map<string, string>();
      const dest: MaterialChannels = {
        color: 'diffuseColor.rgb',
        opacity: 'diffuseColor.a',
        normal: 'normal',
        roughness: 'roughnessFactor',
        metalness: 'metalnessFactor',
      };
      const output = cpu(dest, dest, {
        geometricNormal: 'nonPerturbedNormal',
        destMapAlpha: '1.0',
        sourceUV: 'vec2(0.0)',
        destUV: 'vec2(0.0)',
        sampleSource: channel => dest[channel],
        sampleDest: channel => dest[channel],
        function: (name, code) => {
          functions.set(name, code);
        },
        receiverPositionLocal: receiverLocal ? 'vReceiverPosition' : undefined,
        surfaceVelocity: receiverLocal ? undefined : 'vSurfaceVelocity.xyz',
        surfaceSpeed: receiverLocal ? undefined : 'length(vSurfaceVelocity.xyz)',
        surfaceSupport: receiverLocal ? undefined : 'vSurfaceVelocity.w',
        surfaceVorticity: receiverLocal ? undefined : 'vSurfaceVorticity.xyz',
        surfaceVorticityMagnitude: receiverLocal ? undefined : 'length(vSurfaceVorticity.xyz)',
        surfaceDeformation: receiverLocal ? undefined : 'vSurfaceVorticity.w',
      });
      const varyings = receiverLocal
        ? 'varying vec3 vReceiverPosition;\n'
        : 'varying vec4 vSurfaceVelocity;\nvarying vec4 vSurfaceVorticity;\n';
      shader.vertexShader =
        (receiverLocal ? varyings : `attribute vec4 surfaceVelocity;\nattribute vec4 surfaceVorticity;\n${varyings}`) +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n' +
            (receiverLocal
              ? 'vReceiverPosition = position;'
              : 'vSurfaceVelocity = surfaceVelocity; vSurfaceVorticity = surfaceVorticity;'),
        );
      let block = '';
      if (output.color) block += `diffuseColor.rgb = ${output.color};\n`;
      if (output.opacity) block += `diffuseColor.a = ${output.opacity};\nif (diffuseColor.a <= 0.0) discard;\n`;
      if (output.normal) block += `normal = normalize(${output.normal});\n`;
      if (output.roughness) block += `roughnessFactor = ${output.roughness};\n`;
      if (output.metalness) block += `metalnessFactor = ${output.metalness};\n`;
      shader.fragmentShader =
        varyings +
        [...functions.values()].join('\n') +
        '\n' +
        shader.fragmentShader.replace(
          shader.fragmentShader.includes('#include <lights_physical_fragment>')
            ? '#include <lights_physical_fragment>'
            : '#include <opaque_fragment>',
          block +
            (shader.fragmentShader.includes('#include <lights_physical_fragment>')
              ? '#include <lights_physical_fragment>'
              : '#include <opaque_fragment>'),
        );
    };
  material.needsUpdate = true;
}
