import { VolumeInterpolation } from '../enums/VolumeInterpolation';
import { VolumeDensityMapping } from '../enums/VolumeDensityMapping';

/** Unroll field samplers, while all field copies share their source texture bindings. */
export default function volumeLayersGLSL(
  colors: boolean[], copies: number[], interpolation: string, mapping: string,
): string {
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
    vec3 center = layerDensityMin${index} + layerDensitySize${index} * 0.5;
    vec3 sourcePoint = (point - center - layerOffset${i}) / layerScale${i} + center;
    vec3 uv = (sourcePoint - layerDensityMin${index}) / layerDensitySize${index};
    if (insideField(uv)) {
      float density = max(readVolume(layerDensityMap${index}, uv, layerDensityResolution${index}).r, 0.0);
      density *= layerAlpha${i};
      vec3 color = base;
      ${colors[index] ? `
      vec3 colorUV = (sourcePoint - layerColorMin${index}) / layerColorSize${index};
      if (insideField(colorUV)) {
        vec4 sampleColor = readVolume(layerColorMap${index}, colorUV, layerColorResolution${index});
        color = mix(base, sampleColor.rgb, sampleColor.a);
      }` : ''}
      total += vec4(color * density, density);
    }
  }`).join('\n');
  let opacity = 'smoothstep(max(threshold - range, 0.000001), threshold + range, density)';
  if (mapping === VolumeDensityMapping.None) opacity = '0.0';
  if (mapping === VolumeDensityMapping.Linear) opacity = 'normalizedDensity';
  if (mapping === VolumeDensityMapping.Curve) {
    opacity = 'texture(densityCurve, vec2((normalizedDensity * 255.0 + 0.5) / 256.0, 0.5)).r';
  }
  return `${uniforms}
${transforms}
bool insideField(vec3 uv) {
  return all(greaterThanEqual(uv, vec3(0.0))) && all(lessThanEqual(uv, vec3(1.0)));
}
vec4 readVolume(sampler3D map, vec3 uv, vec3 resolution) {
  ${interpolation === VolumeInterpolation.Nearest ? `
  vec3 texel = clamp(floor(uv * resolution), vec3(0.0), resolution - 1.0);
  return texture(map, (texel + 0.5) / resolution);` : interpolation === VolumeInterpolation.Cubic ? `
  vec3 p = uv * resolution - 0.5;
  vec3 f = fract(p);
  vec3 w0 = pow(1.0 - f, vec3(3.0)) / 6.0;
  vec3 w1 = (3.0 * f * f * f - 6.0 * f * f + 4.0) / 6.0;
  vec3 w2 = (-3.0 * f * f * f + 3.0 * f * f + 3.0 * f + 1.0) / 6.0;
  vec3 w3 = f * f * f / 6.0;
  vec3 g0 = w0 + w1;
  vec3 g1 = w2 + w3;
  vec3 a = (floor(p) - 0.5 + w1 / g0) / resolution;
  vec3 b = (floor(p) + 1.5 + w3 / g1) / resolution;
  return mix(
    mix(mix(texture(map, a), texture(map, vec3(b.x, a.y, a.z)), g1.x),
        mix(texture(map, vec3(a.x, b.y, a.z)), texture(map, vec3(b.x, b.y, a.z)), g1.x), g1.y),
    mix(mix(texture(map, vec3(a.x, a.y, b.z)), texture(map, vec3(b.x, a.y, b.z)), g1.x),
        mix(texture(map, vec3(a.x, b.y, b.z)), texture(map, b), g1.x), g1.y), g1.z);`
    : 'return texture(map, uv);'}
}
vec4 sampleVolume(vec3 coord) {
  vec3 point = (coord + 0.5) * boundsSize + boundsMinimum;
  vec4 total = vec4(0.0);
  ${samples}
  return vec4(total.rgb / max(total.a, 0.000001), total.a);
}
float renderOpacity(float rawDensity) {
  float density = max(rawDensity * densityGain, 0.0);
  float normalizedDensity = clamp((density - densityRange.x) / (densityRange.y - densityRange.x), 0.0, 1.0);
  return density > 0.0 ? clamp(${opacity} * opacity, 0.0, 1.0) : 0.0;
}`;
}
