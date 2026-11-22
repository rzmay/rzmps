import { StorageBufferAttribute } from 'three/webgpu';
import { Fn, float, storage, vec3, vec4 } from 'three/tsl';

/** Compare reconstruction and ray-step changes while the underlying world-space cloud stays fixed. */
export default async function runVolumeScaleSampling() {
  const { red, volume, system, renderer, scene, camera, THREE } = window.volumeFixture;
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 320;
  const context = canvas.getContext('2d');
  camera.position.set(0, 0, 8);
  camera.lookAt(0, 0, 0);

  Object.assign(volume, {
    tags: ['red'],
    generateChildren: false,
    emissive: 1,
    densityMapping: 'Linear',
    opacity: 0.7,
    minDensity: 0,
    maxDensity: 1,
    transmittanceThreshold: 0,
    adaptiveStepping: false,
    dynamicResolution: false,
    downsample: 1,
    sceneDepthClipping: false,
    densityNoiseStrength: 2,
    densityNoiseContrast: 1,
    densityNoiseFrequency: 1,
    densityNoiseSpeed: 0,
    densityNoiseStretch: 0.125,
    densityNoiseStretchBySpeed: null,
    jitterStrength: 1,
    steps: 256,
    samplesPerVoxel: 2,
  });
  red.color = undefined;

  const capture = async () => {
    volume.update([], system, 0);
    await renderer.renderAsync(scene, camera);
    context.drawImage(renderer.domElement, 0, 0);
    return context.getImageData(0, 0, 480, 320).data;
  };
  const difference = (a, b) => a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / a.length;
  const statistics = pixels => {
    let brightness = 0,
      laplacian = 0,
      count = 0;
    for (let y = 1; y < 319; y++)
      for (let x = 1; x < 479; x++) {
        const index = (y * 480 + x) * 4,
          value = pixels[index];
        brightness += value;
        if (value <= 8) continue;
        laplacian += Math.abs(
          4 * value - pixels[index - 4] - pixels[index + 4] - pixels[index - 480 * 4] - pixels[index + 480 * 4],
        );
        count++;
      }
    return { meanBrightness: brightness / (478 * 318), grain: laplacian / Math.max(1, count), visiblePixels: count };
  };

  const cases = [
    { name: 'reference', size: [4, 4, 4], resolution: [32, 32, 32], samples: 2, steps: 256 },
    { name: 'coarser', size: [4, 4, 4], resolution: [16, 16, 16], samples: 2, steps: 256 },
    { name: 'coarser-matched-spacing', size: [4, 4, 4], resolution: [16, 16, 16], samples: 4, steps: 256 },
    { name: 'padded-same-cell-width', size: [4, 4, 32], resolution: [32, 32, 256], samples: 2, steps: 256 },
    { name: 'padded-higher-step-budget', size: [4, 4, 32], resolution: [32, 32, 256], samples: 2, steps: 512 },
  ];
  const output = [];
  let reference;
  for (const item of cases) {
    const size = new THREE.Vector3(...item.size),
      resolution = new THREE.Vector3(...item.resolution);
    const minimum = size.clone().multiplyScalar(-0.5),
      data = new Float32Array(resolution.x * resolution.y * resolution.z);
    for (let z = 0; z < resolution.z; z++)
      for (let y = 0; y < resolution.y; y++) {
        for (let x = 0; x < resolution.x; x++) {
          const point = new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5).divide(resolution).multiply(size).add(minimum);
          data[x + resolution.x * (y + resolution.y * z)] = Math.exp(-point.lengthSq() / (2 * 0.65 ** 2));
        }
      }
    red.density = {
      bounds: new THREE.Box3(minimum, minimum.clone().add(size)),
      resolution,
      data,
      version: 0,
      sampleVelocityGPU: () => vec3(0.6, 1, 0),
    };
    volume.samplesPerVoxel = item.samples;
    volume.steps = item.steps;
    const pixels = await capture(),
      repeated = await capture();
    reference ??= pixels;

    // A fixed physical point must evaluate the same mask regardless of grid size or padded bounds.
    const attribute = new StorageBufferAttribute(new Float32Array(4), 4),
      target = storage(attribute, 'vec4', 1);
    const probe = Fn(() => {
      const local = vec3(0.2, 0.3, 0.4).sub(volume.gpuBoundsMinimum).div(volume.gpuBoundsSize).sub(0.5);
      target
        .element(0)
        .assign(vec4(volume.modulateDensity(local, float(1), float(0), undefined, () => vec3(0.6, 1, 0))));
    })().compute(1);
    renderer.compute(probe);
    const mask = new Float32Array(await renderer.getArrayBufferAsync(attribute))[0];
    probe.dispose();
    attribute.dispose();

    output.push({
      name: item.name,
      cellWidth: volume.gpuCellSize.value,
      samples: item.samples,
      steps: item.steps,
      baseSpacing: volume.gpuCellSize.value / item.samples,
      centerRaySpacing: Math.max(
        volume.gpuCellSize.value / item.samples,
        (camera.position.z + size.z / 2 - Math.max(camera.near, camera.position.z - size.z / 2)) / item.steps,
      ),
      mask,
      ...statistics(pixels),
      repeatError: difference(pixels, repeated),
      referenceError: difference(pixels, reference),
      image: canvas.toDataURL(),
    });
  }
  return output;
}
