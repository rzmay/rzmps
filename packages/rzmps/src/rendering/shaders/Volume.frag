precision highp float;
precision highp sampler3D;

uniform vec3 boundsMinimum;
uniform vec3 boundsSize;
uniform vec3 base;
uniform float threshold;
uniform float range;
uniform float opacity;
uniform float steps;
uniform float jitterStrength;
uniform float jitterSeed;
uniform sampler2D jitterMap;
uniform float anisotropy;
uniform float shadowQuality;
uniform vec3 lightDirection;
uniform vec3 lightColor;
uniform mat4 worldToVolume;
uniform mat4 volumeToWorld;
uniform float cellSize;
uniform float stepSizeMultiplier;
uniform float densityGain;
uniform vec2 densityRange;
uniform sampler2D densityCurve;
uniform bool adaptiveStepping;
uniform float adaptiveStepThreshold;
uniform float adaptiveStepFactor;
uniform float transmittanceThreshold;

in vec3 vOrigin;
in vec3 vDirection;

out vec4 outColor;

vec2 hitBox(vec3 orig, vec3 dir) {
  const vec3 boxMin = vec3(-0.5);
  const vec3 boxMax = vec3(0.5);
  vec3 invDir = 1.0 / dir;
  vec3 tMinTemp = (boxMin - orig) * invDir;
  vec3 tMaxTemp = (boxMax - orig) * invDir;
  vec3 tMin = min(tMinTemp, tMaxTemp);
  vec3 tMax = max(tMinTemp, tMaxTemp);
  float t0 = max(max(tMin.x, tMin.y), tMin.z);
  float t1 = min(min(tMax.x, tMax.y), tMax.z);

  return vec2(t0, t1);
}

// One blue-noise phase per camera ray, independent of world voxels and domain resizing.
float volumeJitterRotation() {
  ivec2 pixel = ivec2(gl_FragCoord.xy) % ivec2(32);
  float rotation = (texelFetch(jitterMap, pixel, 0).r * 255.0 + 0.5) / 256.0;
  uint state = floatBitsToUint(jitterSeed) * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return rotation + float((word >> 22u) ^ word) * (1.0 / 4294967296.0);
}

/* VOLUME_FIELDS */

// Optional coarse, bounded secondary march. Samples extinction, never the color field.
float lightTransmittance(vec3 position, vec3 direction) {
  vec3 inverseDirection = mix(vec3(-1.0), vec3(1.0), step(vec3(0.0), direction)) / max(abs(direction), vec3(0.000001));
  vec3 exits = max((-0.5 - position) * inverseDirection, (0.5 - position) * inverseDirection);
  float far = max(min(min(exits.x, exits.y), exits.z), 0.0);
  float metric = length(direction * boundsSize);
  float budget = clamp(ceil(shadowQuality * 8.0), 1.0, 64.0);
  float spacing = max(cellSize * 2.0 / max(shadowQuality, 0.000001), far * metric / budget) / metric;
  float distance = 0.0;
  float transmission = 1.0;
  for (int i = 0; i < 64; i++) {
    if (float(i) >= budget || distance >= far) break;
    float segment = min(spacing, far - distance);
    vec4 physical = samplePhysical(position + direction * (distance + segment * 0.5));
    float multiplier = volumeAppearance(physical).a;
    transmission *= pow(1.0 - clamp(renderOpacity(physical.y) * multiplier, 0.0, 1.0), segment * metric);
    distance += segment;
    if (transmission <= 0.001) break;
  }
  return transmission;
}

void main() {
  vec3 rayDir = normalize(vDirection);
  vec2 bounds = hitBox(vOrigin, rayDir);

  if (bounds.x > bounds.y) discard;

  bounds.x = max(bounds.x, 0.0);

  float rayLength = max(bounds.y - bounds.x, 0.0);
  float worldLength = length(rayDir * boundsSize) * rayLength;
  // Keep world-space spacing stable across integer sample-count boundaries.
  float worldStep = max(cellSize * stepSizeMultiplier, worldLength / min(512.0, floor(steps)));
  float stepSize = worldStep / length(rayDir * boundsSize);
  // HG / (1 / 4π): unit brightness for isotropic scattering, directional response otherwise.
  vec3 worldDirection = normalize((volumeToWorld * vec4(rayDir, 0.0)).xyz);
  float cosine = dot(worldDirection, lightDirection);
  float phase = (1.0 - anisotropy * anisotropy)
    / pow(1.0 + anisotropy * anisotropy - 2.0 * anisotropy * cosine, 1.5);
  vec3 shadowDirection = normalize((worldToVolume * vec4(lightDirection, 0.0)).xyz);
  float distanceAlongRay = bounds.x;

  vec4 color = vec4(0.0);
  float jitterRotation = volumeJitterRotation();

  for (int i = 0; i < 512; i++) {
    if (!adaptiveStepping) distanceAlongRay = bounds.x + float(i) * stepSize;
    if (float(i) >= floor(steps) || distanceAlongRay >= bounds.y) break;
    float growth = adaptiveStepping
      ? mix(1.0, adaptiveStepFactor, smoothstep(adaptiveStepThreshold, 1.0, color.a)) : 1.0;
    float segment = min(stepSize * growth, bounds.y - distanceAlongRay);
    float offset = mix(0.5, fract(jitterRotation + float(i) * 0.61803398875), jitterStrength);
    vec3 p = vOrigin + rayDir * (distanceAlongRay + segment * offset);

    float opacityMultiplier;
    vec4 volume = sampleVolume(p, opacityMultiplier);
    float d = volume.a;
    float a = 1.0 - pow(1.0 - clamp(renderOpacity(d) * opacityMultiplier, 0.0, 1.0), length(rayDir * boundsSize) * segment);
    vec3 sampleColor = volume.rgb;

    float transmission = shadowQuality > 0.0 ? lightTransmittance(p, shadowDirection) : 1.0;
    vec3 incident = vec3(0.2) + lightColor * (0.8 * phase * transmission);
    // Future emitted radiance belongs alongside this scattered radiance, not in opacity.
    color.rgb += (1.0 - color.a) * a * sampleColor * incident;
    color.a += (1.0 - color.a) * a;

    if (1.0 - color.a <= transmittanceThreshold) break;

    distanceAlongRay += segment;
  }

  if (color.a <= 0.0) discard;

  outColor = vec4(color.rgb / max(color.a, 0.000001), color.a);
  #ifdef TONE_MAPPING
    outColor.rgb = toneMapping(outColor.rgb);
  #endif
  outColor = linearToOutputTexel(outColor);
}
