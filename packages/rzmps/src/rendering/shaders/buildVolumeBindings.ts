import volumeSampling from './VolumeSampling.frag';
import { VolumeInterpolation } from '../../enums/VolumeInterpolation';
import { VolumeDensityMapping } from '../../enums/VolumeDensityMapping';

/** Classic WebGL requires statically named sampler bindings for each volume source.
 * Generate only those bindings/contributions; fixed shader algorithms live in VolumeSampling.frag.
 * Transforms are renderer children reusing a source texture with a different transform and weight.
 */
export default function buildVolumeBindings(
  colors: boolean[], children: number[], interpolation: string, mapping: string,
  channels: Partial<Record<'temperature' | 'speed' | 'vorticity', 1 | 2 | 3>>[] = [],
  appearance: boolean[] = [],
  premultiplied: boolean[] = [],
  emissive = false,
): string {
  const copies = children.flatMap((count, source) => Array<number>(count).fill(source));
  const centers = colors.map((_, index) =>
    `  vec3 center${index} = layerDensityMin${index} + layerDensitySize${index} * 0.5;`).join('\n');
  const parameter = (index: number) => ['temperature', 'speed', 'vorticity'].map(key => {
    const channel = channels[index]?.[key as 'temperature' | 'speed' | 'vorticity'];
    return channel === undefined ? '0.0' : `field[${channel}]`;
  }).join(', ');
  const uniforms = colors.map((hasColor, index) => {
    const fields = hasColor ? ['Density', 'Color'] : ['Density'];
    return fields.map(name => `
uniform sampler3D layer${name}Map${index};
uniform vec3 layer${name}Min${index};
uniform vec3 layer${name}Size${index};
uniform vec3 layer${name}Resolution${index};`).join('\n');
  }).join('\n');
  const transforms = copies.map((_, i) => `
uniform vec3 layerOffset${i};
uniform float layerScale${i};
uniform float layerAlpha${i};`).join('\n');
  const samples = copies.map((index, i) => `
  {
    vec3 sourcePoint = (point - center${index} - layerOffset${i}) / layerScale${i} + center${index};
    vec3 uv = (sourcePoint - layerDensityMin${index}) / layerDensitySize${index};
    if (insideField(uv)) {
      vec4 field = readVolume(layerDensityMap${index}, uv, layerDensityResolution${index});
      float density = max(field.r, 0.0);
      parameters += vec3(${parameter(index)}) * ${premultiplied[index] ? '1.0' : 'density'} * layerAlpha${i};
      density *= layerAlpha${i};
      vec3 color = base;
      ${colors[index] ? `
      vec3 colorUV = (sourcePoint - layerColorMin${index}) / layerColorSize${index};
      if (insideField(colorUV)) {
        vec4 sampleColor = readVolume(layerColorMap${index}, colorUV, layerColorResolution${index});
        color = base * mix(vec3(1.0), sampleColor.rgb, sampleColor.a);
      }` : ''}
      total += vec4(color * density, density);
    }
  }`).join('\n');
  const densitySamples = copies.map((index, i) => `
  {
    vec3 uv = ((point - center${index} - layerOffset${i}) / layerScale${i} + center${index}
      - layerDensityMin${index}) / layerDensitySize${index};
    if (insideField(uv)) {
      vec4 field = readVolume(layerDensityMap${index}, uv, layerDensityResolution${index});
      float density = max(field.r, 0.0) * layerAlpha${i};
      total += vec4(vec3(${parameter(index)}) * ${premultiplied[index] ? `layerAlpha${i}` : 'density'}, density);
    }
  }`).join('\n');
  const interpolationMode = [VolumeInterpolation.Nearest, VolumeInterpolation.Linear, VolumeInterpolation.Cubic]
    .indexOf(interpolation as VolumeInterpolation);
  const mappingMode = [VolumeDensityMapping.None, VolumeDensityMapping.Smoothstep,
    VolumeDensityMapping.Linear, VolumeDensityMapping.Curve].indexOf(mapping as VolumeDensityMapping);
  const defines = [
    `#define VOLUME_INTERPOLATION ${interpolationMode}`,
    `#define VOLUME_DENSITY_MAPPING ${mappingMode}`,
    `#define VOLUME_EMISSIVE ${emissive ? 1 : 0}`,
    ...[0, 1, 2, 3].map(i => `#define VOLUME_APPEARANCE_${i} ${appearance[i] ? 1 : 0}`),
  ].join('\n');
  return `${defines}
${uniforms}
${transforms}
${volumeSampling}
vec4 samplePhysical(vec3 coord) {
  vec3 point = (coord + 0.5) * boundsSize + boundsMinimum;
  vec4 total = vec4(0.0);
  ${centers}
  ${densitySamples}
  return vec4(total.x / max(total.a, 0.000001), total.a, total.yz / max(total.a, 0.000001));
}
vec4 sampleVolume(vec3 coord, out float opacityMultiplier, out float emissiveFactor) {
  vec3 point = (coord + 0.5) * boundsSize + boundsMinimum;
  vec4 total = vec4(0.0);
  vec3 parameters = vec3(0.0);
  ${centers}
  ${samples}
  parameters /= max(total.a, 0.000001);
  vec4 multiplier = volumeAppearance(vec4(parameters.x, total.a, parameters.yz));
  opacityMultiplier = multiplier.a;
  emissiveFactor = volumeEmissive(vec4(parameters.x, total.a, parameters.yz));
  return vec4(total.rgb / max(total.a, 0.000001) * multiplier.rgb, total.a);
}
`;
}
