import * as THREE from 'three';
import { float, texture3D, vec3 } from 'three/tsl';

/** Eager reference retained only for same-state performance and numerical comparisons. */
export default function legacyColliderSample(field, position, inverted, sampleTexture) {
  const uv = position.sub(vec3(field.bounds.min)).div(vec3(field.bounds.getSize(new THREE.Vector3())));
  const texel = uv
    .clamp(0, 1)
    .mul(field.resolution - 1)
    .add(0.5)
    .div(field.resolution);
  const value = sampleTexture ? sampleTexture(texel) : texture3D(field.texture, texel).r;
  return uv
    .greaterThanEqual(0)
    .all()
    .and(uv.lessThanEqual(1).all())
    .select(value, float(inverted ? 1 : 0));
}
