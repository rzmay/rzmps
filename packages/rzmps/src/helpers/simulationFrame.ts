import * as THREE from 'three';
import type { Node } from 'three/webgpu';
import { abs, asin, atan, cos, determinant, float, mat3, mat4, sin, vec3, vec4 } from 'three/tsl';
import type { GPUParticleLike } from '../gpu/Particle';
import type { ParticleCachedValues } from '../Particle';

/** @internal Applies an affine frame change to resolved particle state. */
export function transformParticleFrame(particle: ParticleCachedValues, matrix: THREE.Matrix4): void {
  const linear = new THREE.Matrix3().setFromMatrix4(matrix);
  const rotation = new THREE.Matrix4().extractRotation(matrix);
  const direction = new THREE.Matrix3().setFromMatrix4(rotation);
  const deltaScale = new THREE.Vector3().setFromMatrixScale(matrix);
  const pose = new THREE.Matrix4().compose(new THREE.Vector3(),
    new THREE.Quaternion().setFromEuler(new THREE.Euler().setFromVector3(particle.rotation)), particle.scale);
  pose.premultiply(matrix);
  const quaternion = new THREE.Quaternion();
  pose.decompose(new THREE.Vector3(), quaternion, particle.scale);
  const euler = new THREE.Euler().setFromQuaternion(quaternion);
  particle.rotation.set(euler.x, euler.y, euler.z);
  particle.position.applyMatrix4(matrix);
  particle.orbitCenter.applyMatrix4(matrix);
  particle.velocity.applyMatrix3(linear);
  particle.acceleration.applyMatrix3(linear);
  particle.angularVelocity.applyMatrix3(direction);
  particle.angularAcceleration.applyMatrix3(direction);
  particle.scalarVelocity.multiply(deltaScale);
  particle.scalarAcceleration.multiply(deltaScale);
}

/** @internal XYZ Euler TRS, matching THREE.Matrix4.compose and the CPU particle convention. */
export function particleFrameGPU(particle: GPUParticleLike, inheritScale = 1): Node<'mat4'> {
  const a = cos(particle.rotation.x), b = sin(particle.rotation.x);
  const c = cos(particle.rotation.y), d = sin(particle.rotation.y);
  const e = cos(particle.rotation.z), f = sin(particle.rotation.z);
  const scale = vec3(1).add(particle.scale.sub(1).mul(inheritScale));
  return mat4(
    vec4(vec3(c.mul(e), a.mul(f).add(b.mul(e).mul(d)), b.mul(f).sub(a.mul(e).mul(d))).mul(scale.x), 0),
    vec4(vec3(c.mul(f).negate(), a.mul(e).sub(b.mul(f).mul(d)), b.mul(e).add(a.mul(f).mul(d))).mul(scale.y), 0),
    vec4(vec3(d, b.mul(c).negate(), a.mul(c)).mul(scale.z), 0),
    vec4(particle.position, 1),
  );
}

/** @internal */
export function matrixColumnGPU(matrix: Node<'mat4'>, column: number): Node<'vec4'> {
  return (matrix as unknown as { element(index: number): Node<'vec4'> }).element(column);
}

/** @internal Changes resolved state in its own pass, keeping source bindings out of spatial-query shaders. */
export function transformParticleFrameGPU(particle: GPUParticleLike, matrix: Node<'mat4'>): void {
  const linear = mat3(matrix);
  const x = matrixColumnGPU(matrix, 0).xyz;
  const y = matrixColumnGPU(matrix, 1).xyz;
  const z = matrixColumnGPU(matrix, 2).xyz;
  const deltaScale = vec3(x.length(), y.length(), z.length()).max(vec3(1e-8));
  const direction = mat3(x.div(deltaScale.x), y.div(deltaScale.y), z.div(deltaScale.z));
  const pose = matrix.mul(particleFrameGPU(particle)).toVar('resolvedParticlePose');
  const poseX = matrixColumnGPU(pose, 0).xyz, poseY = matrixColumnGPU(pose, 1).xyz;
  const poseZ = matrixColumnGPU(pose, 2).xyz;
  const scale = vec3(poseX.length(), poseY.length(), poseZ.length()).max(vec3(1e-8)).toVar();
  scale.x.mulAssign(determinant(pose).lessThan(0).select(float(-1), float(1)));
  const m13 = poseZ.x.div(scale.z).clamp(-1, 1);
  const regular = abs(m13).lessThan(0.9999999);
  particle.rotation.assign(vec3(
    regular.select(atan(poseZ.y.negate(), poseZ.z), atan(poseY.z.div(scale.y), poseY.y.div(scale.y))),
    asin(m13),
    regular.select(atan(poseY.x.div(scale.y).negate(), poseX.x.div(scale.x)), float(0)),
  ));
  particle.scale.assign(scale);
  particle.position.assign(matrix.mul(vec4(particle.position, 1)).xyz);
  particle.orbitCenter.assign(matrix.mul(vec4(particle.orbitCenter, 1)).xyz);
  particle.velocity.assign(linear.mul(particle.velocity));
  particle.acceleration.assign(linear.mul(particle.acceleration));
  particle.angularVelocity.assign(direction.mul(particle.angularVelocity));
  particle.angularAcceleration.assign(direction.mul(particle.angularAcceleration));
  particle.scalarVelocity.mulAssign(deltaScale);
  particle.scalarAcceleration.mulAssign(deltaScale);
}
