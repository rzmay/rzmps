// Fixed WebGL volume reconstruction and appearance math, shared by every field contribution.
bool insideField(vec3 uv) {
  return all(greaterThanEqual(uv, vec3(0.0))) && all(lessThanEqual(uv, vec3(1.0)));
}
vec4 sampleVolume(sampler3D map, vec3 uv, vec3 resolution) {
  vec3 halfTexel = 0.5 / resolution;
  vec3 scale = resolution / vec3(textureSize(map, 0));
  return textureLod(map, clamp(uv, halfTexel, 1.0 - halfTexel) * scale, 0.0);
}
vec4 readVolume(sampler3D map, vec3 uv, vec3 resolution) {
  #if VOLUME_INTERPOLATION == 0
  vec3 texel = clamp(floor(uv * resolution), vec3(0.0), resolution - 1.0);
  return sampleVolume(map, (texel + 0.5) / resolution, resolution);
  #elif VOLUME_INTERPOLATION == 2
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
    mix(mix(sampleVolume(map, a, resolution), sampleVolume(map, vec3(b.x, a.y, a.z), resolution), g1.x),
        mix(sampleVolume(map, vec3(a.x, b.y, a.z), resolution), sampleVolume(map, vec3(b.x, b.y, a.z), resolution), g1.x), g1.y),
    mix(mix(sampleVolume(map, vec3(a.x, a.y, b.z), resolution), sampleVolume(map, vec3(b.x, a.y, b.z), resolution), g1.x),
        mix(sampleVolume(map, vec3(a.x, b.y, b.z), resolution), sampleVolume(map, b, resolution), g1.x), g1.y), g1.z);
  #else
  return sampleVolume(map, uv, resolution);
  #endif
}
uniform sampler2D appearanceMap;
uniform vec2 appearanceRange0;
uniform vec2 appearanceRange1;
uniform vec2 appearanceRange2;
uniform vec2 appearanceRange3;
vec4 sampleAppearance(float physical, vec2 limits, float row) {
  float t = clamp((physical - limits.x) / (limits.y - limits.x), 0.0, 1.0);
  return textureLod(appearanceMap, vec2((t * 255.0 + 0.5) / 256.0, row), 0.0);
}
vec4 volumeAppearance(vec4 physical) {
  vec4 multiplier = vec4(1.0);
  #if VOLUME_APPEARANCE_0
  multiplier *= sampleAppearance(physical[0], appearanceRange0, 0.125);
  #endif
  #if VOLUME_APPEARANCE_1
  multiplier *= sampleAppearance(physical[1] * densityGain, appearanceRange1, 0.375);
  #endif
  #if VOLUME_APPEARANCE_2
  multiplier *= sampleAppearance(physical[2], appearanceRange2, 0.625);
  #endif
  #if VOLUME_APPEARANCE_3
  multiplier *= sampleAppearance(physical[3], appearanceRange3, 0.875);
  #endif
  return multiplier;
}
float renderOpacity(float rawDensity) {
  float density = max(rawDensity * densityGain, 0.0);
  float normalizedDensity = clamp((density - densityRange.x) / (densityRange.y - densityRange.x), 0.0, 1.0);
  #if VOLUME_DENSITY_MAPPING == 0
  float mapped = 0.0;
  #elif VOLUME_DENSITY_MAPPING == 2
  float mapped = normalizedDensity;
  #elif VOLUME_DENSITY_MAPPING == 3
  float mapped = textureLod(densityCurve, vec2((normalizedDensity * 255.0 + 0.5) / 256.0, 0.5), 0.0).r;
  #else
  float mapped = smoothstep(max(threshold - range, 0.000001), threshold + range, normalizedDensity);
  #endif
  #if VOLUME_DENSITY_MAPPING != 0
  if (normalizedDensity >= 1.0) mapped = 1.0;
  #endif
  return normalizedDensity > 0.0 ? clamp(mapped * opacity, 0.0, 1.0) : 0.0;
}
