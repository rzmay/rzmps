precision highp float;
precision highp sampler3D;

uniform vec3 boundsMinimum;
uniform vec3 boundsSize;
uniform vec3 base;
uniform float threshold;
uniform float range;
uniform float opacity;
uniform float steps;
uniform float frame;
uniform bool jitter;
uniform float cellSize;
uniform float referenceCellSize;
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

float random(vec3 scale, float seed) {
  return fract(sin(dot(gl_FragCoord.xyz + seed, scale)) * 43758.5453 + seed);
}

/* VOLUME_FIELDS */

void main() {
  vec3 rayDir = normalize(vDirection);
  vec2 bounds = hitBox(vOrigin, rayDir);

  if (bounds.x > bounds.y) discard;

  bounds.x = max(bounds.x, 0.0);

  float rayLength = max(bounds.y - bounds.x, 0.0);
  float worldLength = length(rayDir * boundsSize) * rayLength;
  float count = clamp(ceil(worldLength / (cellSize * stepSizeMultiplier)), 1.0, min(512.0, floor(steps)));
  float stepSize = rayLength / count;
  float offset = jitter ? random(vec3(12.9898, 78.233, 37.719), frame) : 0.5;
  float distanceAlongRay = bounds.x;

  vec4 color = vec4(0.0);

  for (int i = 0; i < 512; i++) {
    if (float(i) >= floor(steps) || distanceAlongRay >= bounds.y) break;
    float growth = adaptiveStepping
      ? mix(1.0, adaptiveStepFactor, smoothstep(adaptiveStepThreshold, 1.0, color.a)) : 1.0;
    float segment = min(stepSize * growth, bounds.y - distanceAlongRay);
    vec3 p = vOrigin + rayDir * (distanceAlongRay + segment * offset);

    vec4 volume = sampleVolume(p);
    float d = volume.a;
    float a = 1.0 - pow(1.0 - renderOpacity(d), length(rayDir * boundsSize) * segment / referenceCellSize);
    vec3 sampleColor = volume.rgb;

    color.rgb += (1.0 - color.a) * a * sampleColor;
    color.a += (1.0 - color.a) * a;

    if (1.0 - color.a <= transmittanceThreshold) break;

    distanceAlongRay += segment;
  }

  if (color.a <= 0.0) discard;

  outColor = vec4(color.rgb / max(color.a, 0.000001), color.a);
}
