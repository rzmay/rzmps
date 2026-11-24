import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { Emitter, ParticleSystem } from '@rzmps/rzmps';

const renderer = new WebGPURenderer();
renderer.setSize(64, 64);
document.body.append(renderer.domElement);
await renderer.init();
const errors = [];
renderer.backend.device.addEventListener('uncapturederror', event => errors.push(event.error.message));
let pipelines = 0;
for (const name of ['createComputePipeline', 'createComputePipelineAsync']) {
  const create = renderer.backend.device[name].bind(renderer.backend.device);
  renderer.backend.device[name] = (...args) => { pipelines++; return create(...args); };
}
window.capacityFixture = { THREE, renderer, ParticleSystem, Emitter, errors, pipelines: () => pipelines };
window.ready = true;
