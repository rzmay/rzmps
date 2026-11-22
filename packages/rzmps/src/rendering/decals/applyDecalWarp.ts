import { ShaderChunk, type Material, type Texture } from 'three';
import type { Node } from 'three/webgpu';
import { attribute, vec3, uv, context } from 'three/tsl';

/** Equivalent homogeneous UV lookup on both backends; receiver vertices remain Three.js-owned. */
export default function applyDecalWarp(material: Material): void {
  const target = material as Material & {
    positionNode?: Node;
    contextNode?: Node & { getFlowContextData(): Record<string, unknown> };
    maskNode?: Node<'bool'>;
    map?: Texture;
    alphaMap?: Texture;
  };
  // Warps fix the footprint origin: six inverse coefficients plus two clipping extents suffice.
  const linear = attribute('decalWarp0', 'vec4'),
    projective = attribute('decalWarp1', 'vec4');
  const p = uv().sub(0.5).mul(projective.zw);
  const homogeneous = vec3(linear.xy.dot(p), linear.zw.dot(p), projective.xy.dot(p).add(1));
  const denominator = homogeneous.z.greaterThanEqual(0).select(homogeneous.z.max(1e-6), homogeneous.z.min(-1e-6));
  const warped = homogeneous.xy.div(denominator).add(0.5);
  const coverage = warped
    .greaterThanEqual(0)
    .all()
    .and(warped.lessThanEqual(1).all())
    .and(homogeneous.z.abs().greaterThan(1e-6));
  // Keep native diffuse-map alpha and lighting; only implicit texture coordinates use the warp.
  // Explicit material-copy atlas coordinates must remain independent of projector UVs.
  target.contextNode = context({
    ...target.contextNode?.getFlowContextData(),
    getUV: () => warped,
    forceUVContext: false,
  }) as unknown as typeof target.contextNode;
  target.maskNode = target.maskNode ? target.maskNode.and(coverage) : coverage;
  const original = material.onBeforeCompile,
    key = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    original.call(material, shader, renderer);
    shader.vertexShader =
      'attribute vec4 decalWarp0;\nattribute vec4 decalWarp1;\n' +
      'varying vec3 vDecalProjective;\n' +
      shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
      vec2 decalPosition = (uv - 0.5) * decalWarp1.zw;
      vDecalProjective = vec3(dot(decalWarp0.xy, decalPosition), dot(decalWarp0.zw, decalPosition),
        dot(decalWarp1.xy, decalPosition) + 1.0);`,
    );
    const maps = [
      'map',
      'alphaMap',
      'normalMap',
      'roughnessMap',
      'metalnessMap',
      'emissiveMap',
      'aoMap',
      'lightMap',
      'bumpMap',
      'transmissionMap',
      'thicknessMap',
    ];
    const declarations = maps
      .filter(key => (material as unknown as Record<string, unknown>)[key])
      .map(key => `uniform mat3 ${key}Transform;`)
      .join('\n');
    shader.fragmentShader = `varying vec3 vDecalProjective;\n${declarations}\n` + shader.fragmentShader;
    const projection = `
      if (abs(vDecalProjective.z) < 0.000001) discard;
      vec2 decalUV = vDecalProjective.xy / vDecalProjective.z + 0.5;
      if (any(lessThan(decalUV, vec2(0.0))) || any(greaterThan(decalUV, vec2(1.0)))) discard;
    `;
    const aliases = maps
      .filter(key => (material as unknown as Record<string, unknown>)[key])
      .map(key => `#define v${key[0].toUpperCase() + key.slice(1)}Uv ` + `(${key}Transform * vec3(decalUV, 1.0)).xy`)
      .join('\n');
    // Expand only the affected fragments after defining their projective UV aliases.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      projection + '\n' + aliases + '\n' + ShaderChunk.map_fragment,
    );
  };
  material.customProgramCacheKey = () => `${key()}:rzmps.decal.projective`;
  // Texture nodes honor context.getUV; this covers color, alpha and normal/roughness maps consistently.
  material.needsUpdate = true;
}
