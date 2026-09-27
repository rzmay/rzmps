import * as THREE from 'three';

export function createLightProbeFallback({
  color = 0xffffff,
  intensity = 1,
  direction = new THREE.Vector3(0, 1, 0),
  directional = 0.25,
} = {}) {
  const lightColor = new THREE.Color(color);
  const sh = new THREE.SphericalHarmonics3();
  const dir = direction.clone().normalize();

  sh.coefficients[0]
    .set(lightColor.r, lightColor.g, lightColor.b)
    .multiplyScalar(0.55 * intensity);

  sh.coefficients[1]
    .copy(sh.coefficients[0])
    .multiplyScalar(dir.y * directional);

  sh.coefficients[2]
    .copy(sh.coefficients[0])
    .multiplyScalar(dir.z * directional);

  sh.coefficients[3]
    .copy(sh.coefficients[0])
    .multiplyScalar(dir.x * directional);

  return new THREE.LightProbe(sh, 1);
}
