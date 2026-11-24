import * as THREE from 'three';
import { createGPUParticleBufferState, DecalRenderer, ParticleSystem, LightRenderer, TrailRenderer } from '@rzmps/rzmps';
import { WebGPURenderer, StorageBufferAttribute } from 'three/webgpu';
import { Fn, If, float, bool, uint, vec4, storage, instanceIndex } from 'three/tsl';
import createHeatLaser from '../../../../examples/presets/heatLaser.js';
import createScene from '../../../../examples/scenes/wallAndSphere.js';
import { getSceneParticleRoot } from '../../../../examples/utils/particleRoot.js';

const renderer = new WebGPURenderer({ antialias: true });
renderer.setSize(800, 600);
document.body.append(renderer.domElement);
await renderer.init();
if (new URLSearchParams(location.search).has('tracePreparation')) {
  const compile = renderer.compileComputeAsync.bind(renderer);
  renderer.compileComputeAsync = async nodes => {
    const names = (Array.isArray(nodes) ? nodes : [nodes]).map(node => node.name || 'unnamed');
    console.log('preparation begin', names.join(','));
    await compile(nodes);
    console.log('preparation end', names.join(','));
  };
}
let groupingBuilds = 0, computePipelineBuilds = 0, renderPipelineBuilds = 0;
const computePipelineLabels = [];
for (const name of ['createRenderPipeline', 'createRenderPipelineAsync']) {
  const create = renderer.backend.device[name].bind(renderer.backend.device);
  renderer.backend.device[name] = (...args) => { renderPipelineBuilds++; return create(...args); };
}
const createPipeline = renderer.backend.device.createComputePipeline.bind(renderer.backend.device);
renderer.backend.device.createComputePipeline = options => {
  computePipelineBuilds++;
  computePipelineLabels.push(options.label ?? 'unnamed');
  if (options.label?.endsWith('rzmps.grouping.reset')) groupingBuilds++;
  return createPipeline(options);
};
const capture = new THREE.RenderTarget(800, 600);
renderer.setRenderTarget(capture);
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 100);
camera.position.set(-7, 4, 9); camera.lookAt(0, 1.7, 0);
const lifecycle = createScene(scene), system = await createHeatLaser();
getSceneParticleRoot(scene).add(system);
const errors = [];
renderer.backend.device.addEventListener('uncapturederror', event => errors.push(event.error.message));
await renderer.renderAsync(scene, camera);
const preparationStarted = performance.now();
await system.prepare(renderer);
const preparationMs = performance.now() - preparationStarted;
const preparedGroupingBuilds = groupingBuilds;
window.laser = {
  renderPipelineBuilds: () => renderPipelineBuilds, pipelineBuilds: () => computePipelineBuilds,
  pipelineLabels: () => computePipelineLabels,
  system, renderer, scene, camera, lifecycle,
  THREE, errors, StorageBufferAttribute, preparationMs, DecalRenderer, ParticleSystem, createGPUParticleBufferState,
  tsl: { Fn, If, float, bool, uint, vec4, storage, instanceIndex } };
window.runLaser = async count => {
  const started = performance.now();
  for (let i = 0; i < count; i++) {
    await new Promise(requestAnimationFrame);
    system.advanceFrames(1, 1 / 60);
    if (i % 30 === 0) await renderer.compileAsync(scene, camera);
    await renderer.renderAsync(scene, camera);
  }
  await renderer.backend.device.queue.onSubmittedWorkDone();
  const demo = system.userData.heatLaser;
  return { ...demo.statistics, groupingBuilds, preparedGroupingBuilds, frameMs: (performance.now() - started) / count,
    particles: system.particles.map(p => p.position.toArray()),
    beams: system.renderers.filter(view => view instanceof TrailRenderer).map(view => ({
      vertices: view.geometry.getAttribute('position').count, side: view.material.side,
    })),
    children: [...system.subSystems.keys()].map(child => ({ name: child.name,
      particles: child.liveParticleCount, gpu: child.isGPUProcessingActive,
      bufferVersion: child.gpuParticleBuffers?.version ?? 0,
      lights: child.renderers.filter(view => view instanceof LightRenderer)
        .flatMap(view => view.lights.map(light => light.intensity)) })),
    errors };
};
window.ready = true;
