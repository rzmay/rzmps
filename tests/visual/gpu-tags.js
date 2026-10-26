import * as THREE from 'three';
import { StorageBufferAttribute } from 'three/webgpu';
import { Fn, instanceIndex, storage, vec2 } from 'three/tsl';
import createTags from '../../examples/tags.js';
import { createWebGPURenderer } from '../../apps/demo/src/rendering/createWebGPURenderer.js';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function verify() {
  const renderer = await createWebGPURenderer({ antialias: false, forceWebGL: false });
  const system = await createTags();
  // Constant values isolate tag selection from sampled callback interpolation.
  system.modules[1].options.alpha = 0.25;
  system.modules[2].options.scale = 2;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 10;
  renderer.setSize(256, 256);
  document.body.append(renderer.domElement);
  scene.add(system, new THREE.AmbientLight(0xffffff, 2));
  const readback = system.selectiveReadback.bind(system);
  let selectiveReads = 0;
  system.selectiveReadback = (...args) => { selectiveReads++; return readback(...args); };
  let warmStats;
  try {
    renderer.render(scene, camera);
    for (let frame = 0; frame < 120; frame++) {
      system.advanceFrames(1, 1 / 60);
      renderer.render(scene, camera);
      await renderer.backend.device.queue.onSubmittedWorkDone();
      if (frame === 20) warmStats = system.gpuConfigurationStats;
    }
    check(system.isGPUProcessingActive, 'The test must use GPU simulation');
    check(selectiveReads === 0, 'Tag filtering must not read particles back to the CPU');
    check(warmStats.pipelineBuilds === system.gpuConfigurationStats.pipelineBuilds,
      'Steady tag filtering must reuse compute pipelines');
    check(warmStats.resourceBuilds === system.gpuConfigurationStats.resourceBuilds,
      'Steady tag filtering must reuse GPU resources');

    const samples = (await readback(system._gpuBuffers.capacity)).filter(sample => sample.valid);
    check(samples.length >= 20, 'Low-rate emission must create a population across many frames');
    const buffers = system._gpuRenderOutputBuffers;
    const renderData = new Float32Array(await renderer.getArrayBufferAsync(buffers.attributes.floatData));
    const attribute = new StorageBufferAttribute(new Float32Array(buffers.count * 2), 2);
    const visibility = storage(attribute, 'vec2', buffers.count);
    const node = Fn(() => {
      visibility.element(instanceIndex).assign(vec2(
        system.renderers[0].getGPUVisibilityNode(buffers.particle, system),
        system.renderers[1].getGPUVisibilityNode(buffers.particle, system),
      ));
    })().compute(buffers.count);
    renderer.compute(node);
    const masks = new Float32Array(await renderer.getArrayBufferAsync(attribute));
    const counts = { spheres: 0, cubes: 0 };
    for (const { slot, particle } of samples) {
      const tag = slot % 2 === 0 ? 'spheres' : 'cubes';
      check(particle.tags?.length === 1 && particle.tags[0] === tag,
        `Slot ${slot} must select ${tag} independently of its per-frame emission request`);
      counts[tag]++;
      check(masks[slot * 2] === (tag === 'spheres' ? 1 : 0), `Wrong sprite mask at slot ${slot}`);
      check(masks[slot * 2 + 1] === (tag === 'cubes' ? 1 : 0), `Wrong mesh mask at slot ${slot}`);
      const alpha = tag === 'cubes' ? 0.25 : 1;
      check(Math.abs(renderData[slot * 16 + 3] - alpha) < 0.0001,
        `The alpha module must affect only cubes at slot ${slot}: ${renderData[slot * 16 + 3]} vs ${alpha}`);
      const scale = tag === 'spheres' ? 2 : 1;
      check(Math.abs(renderData[slot * 16 + 8] - particle.scale.x * scale) < 0.0001,
        `The scale module must affect only spheres at slot ${slot}`);
    }
    check(counts.spheres > 3 && counts.cubes > 3, 'Both renderers must receive many particles');
    node.dispose();
    return { counts, stats: system.gpuConfigurationStats };
  } finally {
    system.destroy();
    renderer.dispose();
  }
}

verify().then(result => { window.gpuTagsResult = result; }, error => {
  window.gpuTagsResult = { error: error.stack ?? String(error) };
});
