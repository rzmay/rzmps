import { positionView, uv, nodeObject, normalViewGeometry, Fn, float, texture } from 'three/tsl';
import type { MeshStandardMaterial } from 'three';
import type { Node } from 'three/webgpu';

/** Color is linear RGB; opacity is linear scalar; normals are normalized view-space directions. */
export interface MaterialChannels<Color = string, Scalar = string> {
  color: Color;
  opacity: Scalar;
  normal: Color;
  roughness: Scalar;
  metalness: Scalar;
}
export type MaterialChannel = keyof MaterialChannels;
export type GPUMaterialChannels = MaterialChannels<Node<'vec3'>, Node<'float'>>;

export interface MaterialCompositeContext {
  /** Unperturbed, normalized view-space surface normal. */
  geometricNormal: string;
  /** Product of available destination normal/roughness/metalness map alpha channels. */
  destMapAlpha: string;
  sourceUV: string;
  destUV: string;
  sampleSource(channel: MaterialChannel, coordinates: string): string;
  sampleDest(channel: MaterialChannel, coordinates: string): string;
  function(name: string, source: string): void;
}
export interface MaterialCompositeGPUContext {
  geometricNormal: Node<'vec3'>;
  destMapAlpha: Node<'float'>;
  sourceUV: Node<'vec2'>;
  destUV: Node<'vec2'>;
  sampleSource<C extends MaterialChannel>(channel: C, coordinates: Node<'vec2'>): GPUMaterialChannels[C];
  sampleDest<C extends MaterialChannel>(channel: C, coordinates: Node<'vec2'>): GPUMaterialChannels[C];
}
export type MaterialCompositeCallback = (source: Readonly<MaterialChannels>, dest: Readonly<MaterialChannels>,
  context: MaterialCompositeContext) => Partial<MaterialChannels>;
export type MaterialCompositeGPUCallback = (source: Readonly<GPUMaterialChannels>, dest: Readonly<GPUMaterialChannels>,
  context: MaterialCompositeGPUContext) => Partial<GPUMaterialChannels>;
export interface MaterialCompositeConfiguration {
  materialComposite?: MaterialCompositeCallback;
  materialCompositeGPU?: MaterialCompositeGPUCallback;
  version?: number;
}

/** Sampled source inputs. The stored normal is tangent-space; public composite channels convert it to view space. */
export interface AppearanceNodes {
  color: Node<'vec3'>;
  alpha: Node<'float'>;
  normal: Node<'vec3'>;
  roughness: Node<'float'>;
  metalness: Node<'float'>;
  normalUV: Node<'vec2'>;
  sourceUV: Node<'vec2'>;
  valid: Node<'bool'>;
  resample(coordinates: Node<'vec2'>): AppearanceNodes;
  compositeGPU(dest: GPUMaterialChannels, destUV?: Node<'vec2'>): GPUMaterialChannels;
}

export function sourceNormalView(copy: AppearanceNodes, base: Node<'vec3'>): Node<'vec3'> {
  const q0 = positionView.dFdx(), q1 = positionView.dFdy();
  const st0 = copy.normalUV.dFdx(), st1 = copy.normalUV.dFdy();
  const t = q0.mul(st1.y).sub(q1.mul(st0.y));
  const b = q1.mul(st0.x).sub(q0.mul(st1.x));
  const scale = t.dot(t).max(b.dot(b)).max(1e-12).sqrt().reciprocal();
  return t.mul(copy.normal.x).add(b.mul(copy.normal.y)).mul(scale).add(base.mul(copy.normal.z)).normalize();
}

/** Shared by every material-capable renderer; callback choice follows rendering, never simulation. */
export function compositeGPU(copy: AppearanceNodes, dest: GPUMaterialChannels,
  callback?: MaterialCompositeGPUCallback, destUV: Node<'vec2'> = uv()): GPUMaterialChannels {
  if (!callback) return { color: dest.color.mul(copy.color), opacity: dest.opacity.mul(copy.alpha),
    normal: sourceNormalView(copy, dest.normal), roughness: dest.roughness.mul(copy.roughness),
    metalness: dest.metalness.mul(copy.metalness) };

  const sample = <C extends MaterialChannel>(channel: C, input: AppearanceNodes): GPUMaterialChannels[C] => {
    const value = channel === 'normal' ? sourceNormalView(input, dest.normal)
      : channel === 'opacity' ? input.alpha : input[channel as 'color' | 'roughness' | 'metalness'];
    return input.valid.select(value, dest[channel]) as GPUMaterialChannels[C];
  };
  // Lazy property getters keep unused source channels out of the shader graph.
  const source = Object.fromEntries(
    Object.keys(dest).map(channel => [channel, undefined]),
  ) as unknown as GPUMaterialChannels;
  for (const channel of Object.keys(dest) as MaterialChannel[]) Object.defineProperty(source, channel, {
    get: () => sample(channel, copy), enumerable: true,
  });
  const overrides = callback(source, dest, {
    sourceUV: copy.sourceUV, destUV,
    geometricNormal: normalViewGeometry,
    get destMapAlpha() {
      return Fn(builder => {
        const material = builder.material as MeshStandardMaterial;
        let alpha: Node<'float'> = float(1);
        for (const key of ['normalMap', 'roughnessMap', 'metalnessMap'] as const) {
          if (material[key]) alpha = alpha.mul(texture(material[key]!).a);
        }
        return alpha;
      })();
    },
    sampleSource: (channel, coordinates) => sample(channel, copy.resample(coordinates)),
    sampleDest: (channel, coordinates) => nodeObject(dest[channel]).context({
      getUV: () => coordinates, forceUVContext: true,
    }) as unknown as typeof dest[typeof channel],
  });
  return { ...dest, ...overrides };
}

/** Applies complete material channels at Three.js's node-material input stages. */
export function applyMaterialCopies(material: object, copies: AppearanceNodes[], dest: GPUMaterialChannels): void {
  const channels = copies.reduce((value, copy) => copy.compositeGPU(value), dest);
  Object.assign(material, { colorNode: channels.color, opacityNode: channels.opacity,
    normalNode: channels.normal, roughnessNode: channels.roughness, metalnessNode: channels.metalness });
}
