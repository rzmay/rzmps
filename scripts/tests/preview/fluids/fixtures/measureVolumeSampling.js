import * as THREE from 'three';
import { StorageBufferAttribute } from 'three/webgpu';
import { Fn, floatBitsToUint, floor, fract, hash, ivec3, screenCoordinate, storage, uint, vec2, vec3 } from 'three/tsl';
import { passTimer } from './volume-quality.js';

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Retired spatial lattice, preserved only for before/after comparisons. */
export function legacyVolumeJitter(point, index, seed) {
  const cell = ivec3(floor(vec3(point.dot(vec3(0.7548777, 0.5698403, 0.438289)),
    point.dot(vec3(-0.438289, 0.7548777, 0.5698403)),
    point.dot(vec3(0.5698403, -0.438289, 0.7548777))).mul(16)));
  const key = uint(cell.x).mul(73856093).bitXor(uint(cell.y).mul(19349663))
    .bitXor(uint(cell.z).mul(83492791)).bitXor(floatBitsToUint(seed));
  return fract(hash(key).add(index.mul(0.61803398875)).add(0.5));
}

/** Check actual volume reconstruction at fractional texels, independently of the raymarch. */
export async function probeVolumeInterpolation(volume, renderer) {
  const output = new StorageBufferAttribute(new Float32Array(8), 4), target = storage(output, 'vec4', 2);
  const results = [];
  for (const type of [THREE.FloatType, THREE.HalfFloatType]) {
    const values = [];
    for (let z = 0; z < 2; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
      values.push(1 + 2 * x + 3 * y + 5 * z, 0, 0, 1);
    }
    const data = type === THREE.FloatType ? new Float32Array(values)
      : Uint16Array.from(values.map(THREE.DataUtils.toHalfFloat));
    const texture = new THREE.Data3DTexture(data, 2, 2, 2);
    Object.assign(texture, { type, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter, needsUpdate: true });
    const binding = volume.bindField({ texture, channels: 4, bounds: new THREE.Box3(
      new THREE.Vector3(), new THREE.Vector3(1, 1, 1)), resolution: new THREE.Vector3(2, 2, 2), version: 0 }, 4);
    volume.interpolation = 'Linear';
    const node = Fn(() => {
      target.element(0).assign(volume.readVolume(binding, vec3(0.4, 0.55, 0.7)));
      target.element(1).assign(volume.readVolume(binding, vec3(0.6, 0.45, 0.3)));
    })().compute(1);
    renderer.compute(node);
    const actual = [...new Float32Array(await renderer.getArrayBufferAsync(output))];
    results.push({ type, actual, expected: [7.9, 0, 0, 1, 4.1, 0, 0, 1] });
    node.dispose(); texture.dispose();
  }
  output.dispose();
  return results;
}

/** Compare the same frozen physical fields; all candidates retain full-strength, full-stratum jitter. */
export async function measureVolumeSampling() {
  const { renderer, system, scene, camera } = window.debugFluid;
  for (let i = 0; i < 15; i++) {
    await window.runFrames(10);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  system.pause();
  const volume = system.renderers.find(renderer => renderer.constructor.name === 'VolumeRenderer');
  scene.background = new THREE.Color(0);
  scene.traverse(object => {
    if (object.isMesh && object !== volume.mesh && object !== system._contextCaptureDummy) object.visible = false;
  });
  const interpolation = await probeVolumeInterpolation(volume, renderer);
  const createJitter = volume.createRayJitter.bind(volume), oldRead = volume.readVolume.bind(volume);
  const oldJitter = (point, index) => legacyVolumeJitter(point, index, volume.gpuJitterSeed);
  const screenJitter = (_point, index) => {
    const rotation = fract(fract(screenCoordinate.xy.dot(vec2(0.06711056, 0.00583715))).mul(52.9829189));
    const seed = hash(floatBitsToUint(volume.gpuJitterSeed));
    return fract(rotation.add(seed).add(index.mul(0.61803398875)));
  };
  const smoothJitter = (point, index) => {
    const phase = point.dot(vec3(13.193, 17.371, 23.719)).add(index.mul(0.61803398875))
      .add(hash(floatBitsToUint(volume.gpuJitterSeed)));
    return fract(phase).sub(0.5).abs().mul(2);
  };
  Object.assign(volume, { dynamicResolution: false, downsample: 1, jitterStrength: 1 });
  camera.position.set(3.4, 2.4, 4.1); camera.lookAt(0, 1.8, 0);
  renderer.setPixelRatio(1); renderer.setSize(800, 600);
  camera.aspect = 4 / 3; camera.updateProjectionMatrix();
  const timer = passTimer(renderer.backend.device, renderer.backend, () => 'volume');
  const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 600;
  const context = canvas.getContext('2d'), images = [], rows = [];
  try {
    for (const name of ['world', 'screen', 'blue', 'smooth', 'blend', 'cubic', 'reference']) {
      volume.createRayJitter = name === 'blue' || name === 'reference' ? createJitter
        : () => name === 'world' ? oldJitter : name === 'smooth' ? smoothJitter : screenJitter;
      volume.interpolation = name === 'cubic' ? 'Cubic' : 'Linear';
      volume.steps = name === 'reference' ? 512 : 256;
      volume.samplesPerVoxel = name === 'reference' ? 12 : 2;
      volume.readVolume = name === 'blend' ? (binding, uv) => {
        if (!volume.layers.some(layer => layer.density === binding)) return oldRead(binding, uv);
        let value = oldRead(binding, uv).mul(0.75);
        for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
          const offset = [0, 0, 0]; offset[axis] = sign * 0.25;
          value = value.add(oldRead(binding, uv.add(vec3(...offset).div(binding.resolutionNode))).mul(1 / 24));
        }
        return value;
      } : oldRead;
      volume.update([], system, 0); volume.updateMaterialTexture(); volume.update([], system, 0);
      for (let i = 0; i < 3; i++) await renderer.renderAsync(scene, camera);
      await renderer.backend.device.queue.onSubmittedWorkDone();
      const timings = [];
      for (let i = 0; i < 8; i++) {
        timer.start(); await renderer.renderAsync(scene, camera); timings.push(await timer.finish());
      }
      // Read in the same turn as the draw; presentation may discard the canvas after the timing readback.
      await renderer.renderAsync(scene, camera);
      context.drawImage(renderer.domElement, 0, 0);
      images.push(new Uint8Array(context.getImageData(0, 0, 800, 600).data));
      rows.push({ name, medianGPUms: median(timings.map(row => row.totalGPUms)),
        image: canvas.toDataURL('image/png') });
    }
  } finally { timer.dispose(); }
  const reference = images.at(-1);
  for (let item = 0; item < rows.length; item++) {
    let error = 0, lowFrequencyError = 0, count = 0;
    for (let y = 2; y < 598; y++) for (let x = 2; x < 798; x++) {
      const p = 4 * (x + 800 * y);
      // Exclude the checkerboard and use pixels containing the rendered gas.
      if (Math.abs(reference[p] - reference[p + 2]) < 2 && reference[p] < 8) continue;
      let local = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const q = 4 * (x + dx + 800 * (y + dy));
        local += images[item][q] - reference[q];
      }
      error += (images[item][p] - reference[p]) ** 2;
      lowFrequencyError += (local / 25) ** 2; count++;
    }
    Object.assign(rows[item], { rmse: Math.sqrt(error / count), blockRMSE: Math.sqrt(lowFrequencyError / count) });
  }
  return { interpolation, rows, bounds: [...volume.bounds.min.toArray(), ...volume.bounds.max.toArray()],
    cellSize: system.modules[0].cellSize, jitterStrength: volume.jitterStrength };
}
