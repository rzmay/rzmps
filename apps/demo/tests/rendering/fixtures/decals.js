import * as THREE from 'three';
import { passTimer } from '../../../../../benchmarks/lib/passTimer.js';
import { WebGPURenderer } from 'three/webgpu';
import { vec2 } from 'three/tsl';
import { DecalRenderer, Renderer, Particle, ParticleSystem, createGPUParticleBufferState } from '@rzmps/rzmps';

const backend = new URLSearchParams(location.search).get('backend') ?? 'webgpu';
const renderer = backend === 'webgl' ? new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, stencil: true })
  : new WebGPURenderer({ antialias: false, trackTimestamp: true, stencil: true });
await renderer.init?.();
renderer.setSize(256, 256); renderer.setPixelRatio(1);
document.body.append(renderer.domElement);
const timer = renderer.backend?.device?.features.has('timestamp-query')
  ? passTimer(renderer.backend.device, renderer.backend, () => 'decal/render') : undefined;
const fence = async () => {
  if (renderer.backend?.device) await renderer.backend.device.queue.onSubmittedWorkDone();
  else renderer.getContext().finish();
};
const scene = new THREE.Scene(); scene.background = new THREE.Color('#888888');
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
camera.position.set(0, 3, 0.001); camera.lookAt(0, 0, 0);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial({ color: 'white' }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor); scene.updateMatrixWorld(true);
const colorMap = new THREE.DataTexture(new Uint8Array([
  255, 120, 70, 255, 80, 255, 160, 255, 90, 120, 255, 255, 255, 255, 255, 255,
]), 2, 2);
colorMap.needsUpdate = true; colorMap.repeat.set(0.8, 0.7); colorMap.offset.set(0.1, 0.15);
const paintMaterial = new THREE.MeshBasicMaterial({ color: '#102040', map: colorMap });
const paint = new DecalRenderer(paintMaterial, {
  size: 1.5, lifetime: 100, warp: DecalRenderer.Warp.Combine(
    DecalRenderer.Warp.Rotate(0.4), DecalRenderer.Warp.Perspective(new THREE.Vector2(0.7, -0.4))),
});
const system = new ParticleSystem({ gpuProcessing: false, emitters: [], renderers: [paint] });
scene.add(system); scene.updateMatrixWorld(true);
const particle = new Particle({ position: new THREE.Vector3(0, 0.1, 0), lifetime: 10 });
system._notifySpawn(particle);
if (renderer.renderAsync) await renderer.renderAsync(scene, camera);
else renderer.render(scene, camera);

window.checkSelection = async () => {
  class Capture extends Renderer {
    setup() {} clear() {} destroy() { this.reset(); }
    _update(particles) { this.particles = particles; }
    _updateGPU(buffers) { this.buffers = buffers; }
  }
  const particles = Array.from({ length: 32 }, (_, i) => new Particle({
    position: new THREE.Vector3(i - 16, 0.5, 0), lifetime: 100, mass: i + 1,
  }));
  const input = createGPUParticleBufferState(particles); input.initialize(renderer);
  const selected = new Capture({ condition: p => p.position.x >= 0,
    conditionGPU: p => p.position.x.greaterThanEqual(0), children: { count: 2 } });
  selected.update(particles, system, 1 / 60);
  const cpu = selected.particles.length;
  // Capture the actual GPU output states, not its conservative CPU capacity.
  selected.updateGPU(input, system, 1 / 60);
  const output = selected.buffers;
  const values = new Uint32Array(await renderer.getArrayBufferAsync(output.attributes.uintData));
  let live = 0;
  for (let i = 0; i < values.length; i += 4) if (values[i]) live++;
  const positions = new Float32Array(await renderer.getArrayBufferAsync(output.attributes.floatData));
  const invalid = Array.from({ length: values.length / 4 }, (_, i) => i)
    .filter(i => values[i * 4]).some(i => positions[i * output.floatStride] < 0);
  selected.count = 1;
  selected.update(particles, system, 1 / 60);
  const groupedCPU = selected.particles.length;
  selected.updateGPU(input, system, 1 / 60);
  const groupedState = new Uint32Array(await renderer.getArrayBufferAsync(selected.buffers.attributes.uintData));
  let groupedGPU = 0;
  for (let i = 0; i < groupedState.length; i += 4) if (groupedState[i]) groupedGPU++;
  selected.condition = () => false;
  selected.conditionGPU = p => p.position.x.lessThan(-100);
  selected.needsUpdate = true;
  selected.updateGPU(input, system, 1 / 60);
  const emptyState = new Uint32Array(await renderer.getArrayBufferAsync(selected.buffers.attributes.uintData));
  const empty = emptyState.every((value, index) => index % 4 !== 0 || value === 0);
  selected.destroy(); input.dispose(renderer);
  return { cpu, gpu: live, invalid, groupedCPU, groupedGPU, empty };
};

async function measureRender() {
  const draw = async () => {
    if (renderer.renderAsync) await renderer.renderAsync(scene, camera);
    else renderer.render(scene, camera);
  };
  await renderer.compileAsync?.(scene, camera);
  for (let i = 0; i < 2; i++) { await draw(); await fence(); }
  const samples = [];
  renderer.info.autoReset = false;
  for (let i = 0; i < 5; i++) {
    renderer.info.reset(); timer?.start();
    const start = performance.now();
    await draw();
    const submissionMs = performance.now() - start;
    await fence();
    const fencedRenderMs = performance.now() - start;
    const timing = timer ? await timer.finish() : null;
    samples.push({ submissionMs, fencedRenderMs, renderGpuMs: timing?.renderPassGPUms ?? null,
      draws: renderer.info.render.drawCalls ?? renderer.info.render.calls, passes: timing?.passes });
  }
  const median = key => samples.map(sample => sample[key]).filter(Number.isFinite)
    .sort((a, b) => a - b)[2] ?? null;
  return { submissionMs: median('submissionMs'), fencedRenderMs: median('fencedRenderMs'),
    renderGpuMs: median('renderGpuMs'), draws: samples[2].draws, samples };
}

window.benchmarkDecals = async (count, warp = 'none') => {
  paint.clear(); paint.maxDecals = count;
  paint.warp = warp === 'ray' ? DecalRenderer.Warp.FromRay()
    : warp === 'combined' ? DecalRenderer.Warp.Combine(DecalRenderer.Warp.FromRay(),
      DecalRenderer.Warp.Scale(new THREE.Vector2(1.5, 0.7)))
      : warp === 'anisotropic' ? DecalRenderer.Warp.Scale(new THREE.Vector2(1.5, 0.7)) : undefined;
  let projectionMs = 0, geometryMs = 0;
  const query = paint.findHits, geometry = paint.createGeometry;
  paint.findHits = function (...args) { const start = performance.now();
    const value = query.apply(this, args); projectionMs += performance.now() - start; return value; };
  paint.createGeometry = function (...args) { const start = performance.now();
    const value = geometry.apply(this, args); geometryMs += performance.now() - start; return value; };
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    particle.position.x = (i % 100 - 50) * 0.05;
    particle.position.z = (Math.floor(i / 100) - 50) * 0.05;
    system._notifySpawn(particle);
  }
  const creationMs = performance.now() - start;
  paint.findHits = query; paint.createGeometry = geometry;
  const submit = performance.now(); paint.update([], system, 0.01);
  const updateMs = performance.now() - submit;
  for (const batch of paint.batches.values()) batch.mesh.perObjectFrustumCulled = false;
  const batched = await measureRender();
  let objects = 0; scene.traverse(() => objects++);

  // Rendering-only baseline: identical clipped geometry and transforms, one Mesh per decal.
  for (const batch of paint.batches.values()) batch.mesh.visible = false;
  const baseline = new THREE.Group(), baselineMaterial = paintMaterial.clone();
  baselineMaterial.transparent = true; baselineMaterial.depthWrite = false;
  for (const decal of paint.decals) {
    const mesh = new THREE.Mesh(decal.geometry, baselineMaterial);
    mesh.matrixAutoUpdate = false; mesh.matrix.copy(decal.receiver.matrixWorld);
    mesh.frustumCulled = false; baseline.add(mesh);
  }
  scene.add(baseline);
  const perObject = { ...await measureRender(), sceneObjects: objects + baseline.children.length + 1 };
  baseline.removeFromParent(); baselineMaterial.dispose();
  for (const batch of paint.batches.values()) batch.mesh.visible = true;
  return { backend, count: paint.count, warp, creationMs, projectionMs, geometryMs, updateMs,
    renderSubmissionMs: batched.submissionMs, fencedRenderMs: batched.fencedRenderMs,
    renderGpuMs: batched.renderGpuMs, draws: batched.draws, renderSamples: batched.samples,
    objects, perObject, ...paint.batchDiagnostics, memory: { ...renderer.info.memory } };
};

window.checkReadbackCondition = async () => {
  const samples = Array.from({ length: 20 }, (_, i) => new Particle({
    position: new THREE.Vector3((i - 10) * 0.02, 0.1, 0), lifetime: 20, mass: i + 1,
  }));
  for (const sample of samples) sample.realtime = 250;
  const input = createGPUParticleBufferState(samples); input.initialize(renderer);
  const selected = new DecalRenderer(new THREE.MeshBasicMaterial(), {
    onSpawn: false, continuousRate: 5, condition: p => p.position.x >= 0,
    conditionGPU: p => p.position.x.greaterThanEqual(0), lifetime: 10,
  });
  const source = new ParticleSystem({ emitters: [], renderers: [selected] });
  scene.add(source); await renderer.renderAsync(scene, camera);
  // This system owns no simulation slots; direct canonical input contains every required field.
  selected.updateGPU(input, source, 0.25);
  while (selected._gpuReadbackPending) await new Promise(resolve => setTimeout(resolve, 1));
  const snapshots = await selected._gpuSelection.readback();
  const result = { count: selected.count, ids: selected.decals.map(d => d.appearanceParticle.id),
    snapshots: snapshots.map(p => ({ id: p.id, age: p.realtime, alive: p.alive, position: p.position.toArray() })) };
  selected.destroy(); source.removeFromParent(); input.dispose(renderer);
  return result;
};
window.ready = true;

window.benchmarkConditions = () => {
  const result = [];
  const samples = Array.from({ length: 1000 }, (_, i) => new Particle({
    position: new THREE.Vector3((i % 10) * 0.01, 0.1, 0), lifetime: 20,
  }));
  samples.forEach((p, i) => { p.id = `condition:${i}`; });
  for (const fraction of [1, 0.01]) {
    paint.clear(); paint.maxDecals = 1000;
    paint.condition = p => Number(p.id.split(':')[1]) < samples.length * fraction;
    let rays = 0;
    const query = paint.findHits;
    paint.findHits = function (...args) { rays++; return query.apply(this, args); };
    const start = performance.now();
    for (const particle of samples) system._notifySpawn(particle);
    result.push({ fraction, ms: performance.now() - start, rays, decals: paint.count });
    paint.findHits = query;
  }
  paint.condition = undefined;
  return result;
};

window.checkCompositeDecal = async () => {
  const view = new DecalRenderer(new THREE.MeshStandardMaterial(), {
    warp: DecalRenderer.Warp.FromRay(), materialCompositeGPU: (_source, dest) => dest,
  });
  const source = new ParticleSystem({ emitters: [], renderers: [view] });
  scene.add(source); scene.updateMatrixWorld(true);
  source._notifySpawn(new Particle({ position: new THREE.Vector3(0, 0.1, 0), lifetime: 10 }));
  await renderer.renderAsync(scene, camera);
  await renderer.backend.device.queue.onSubmittedWorkDone();
  const attributes = Object.keys(view.decals[0].mesh.geometry.attributes);
  source.destroy();
  return attributes;
};

window.checkActualPreset = async name => {
  window.actualPreset?.root.destroy();
  if (!window.actualScene) {
    floor.removeFromParent();
    const createCheckerboard = (await import('../../../../../examples/scenes/checkerboard.js')).default;
    window.actualScene = createCheckerboard(scene);
    camera.position.set(5, 6, 7); camera.lookAt(0, 0, 0);
  }
  const factory = name === 'acid'
    ? (await import('../../../../../examples/presets/acid.js')).default
    : (await import('../../../../../examples/presets/splatter.js')).default;
  paint.clear();
  const root = await factory();
  root.prewarm = false;
  scene.userData.__rzmps_particleRoot.add(root);
  const decal = root.renderers.find(view => view instanceof DecalRenderer);
  for (const texture of [decal.material.map, decal.material.normalMap]) {
    const image = texture?.image;
    if (image && !image.complete) await new Promise((resolve, reject) => {
      image.addEventListener('load', resolve, { once: true });
      image.addEventListener('error', reject, { once: true });
    });
  }
  if (renderer.renderAsync) await renderer.renderAsync(scene, camera);
  else renderer.render(scene, camera);
  if (renderer.backend?.device) await root.prepare(renderer);
  for (let i = 0; i < 480; i++) {
    root.advanceFrames(1, 1 / 60);
    if (i % 10 === 0) {
      if (renderer.renderAsync) await renderer.renderAsync(scene, camera);
      else renderer.render(scene, camera);
      await fence();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  if (renderer.renderAsync) await renderer.renderAsync(scene, camera);
  else renderer.render(scene, camera);
  await fence();
  window.actualPreset = { root, decal };
  return { decals: decal.count, gpu: root.isGPUProcessingActive, events: root.gpuEventStats,
    batch: decal.batchDiagnostics, first: decal.decals[0] && {
      opacity: decal.decals[0].renderedOpacity, color: decal.decals[0].color.toArray(),
      receiver: decal.decals[0].receiver.type,
    } };
};

window.checkDecalSampling = async () => {
  paint.clear();
  const map = new THREE.DataTexture(new Uint8Array([
    255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
  ]), 2, 2);
  map.needsUpdate = true;
  const whiteMap = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]), 2, 2);
  whiteMap.needsUpdate = true;
  const white = new THREE.MeshBasicMaterial({ map: whiteMap });
  const pixels = [];
  for (const composed of [false, true, ...(backend === 'webgpu' ? ['legacy'] : [])]) {
    const material = new THREE.MeshBasicMaterial({ color: '#103080', map });
    const view = new DecalRenderer(material, {
      inheritMaterial: composed, materialTarget: composed ? white : undefined,
      materialCompositeGPU: composed ? (_source, dest, context) => ({
        color: dest.color.mul(context.sampleSource('color', vec2(0.25, 0.25))), opacity: dest.opacity,
      }) : undefined,
      materialComposite: composed ? (_source, dest, context) => ({
        color: `${dest.color} * ${context.sampleSource('color', 'vec2(0.25)')}`, opacity: dest.opacity,
      }) : undefined,
      atlasOptions: { minCapacity: 4 }, size: 1.5,
      warp: DecalRenderer.Warp.Perspective(new THREE.Vector2(0.3, 0.2)),
    });
    const owner = new ParticleSystem({ gpuProcessing: false, emitters: [], renderers: [view] });
    scene.add(owner); scene.updateMatrixWorld(true);
    owner._notifySpawn(new Particle({ position: new THREE.Vector3(0, 0.1, 0), lifetime: 10 }));
    if (composed === 'legacy') {
      for (const batch of view.batches.values()) {
        batch.mesh.material.contextNode.value.forceUVContext = true;
        batch.mesh.material.needsUpdate = true;
      }
    }
    const target = backend === 'webgl'
      ? new THREE.WebGLRenderTarget(256, 256) : new THREE.RenderTarget(256, 256);
    renderer.setRenderTarget(target);
    if (renderer.renderAsync) await renderer.renderAsync(scene, camera);
    else renderer.render(scene, camera);
    await fence();
    const data = renderer.readRenderTargetPixelsAsync
      ? await renderer.readRenderTargetPixelsAsync(target, 0, 0, 256, 256,
        ...(backend === 'webgl' ? [new Uint8Array(256 * 256 * 4)] : []))
      : renderer.readRenderTargetPixels(target, 0, 0, 256, 256, new Uint8Array(256 * 256 * 4));
    pixels.push(new Uint8Array(data));
    renderer.setRenderTarget(null); target.dispose(); owner.destroy(); material.dispose();
  }
  let mismatch = 0, legacyMismatch = 0, colored = 0, transparent = 0;
  for (let i = 0; i < pixels[0].length; i += 4) {
    if (Math.abs(pixels[0][i] - pixels[1][i]) > 5) mismatch++;
    if (pixels[2] && Math.abs(pixels[0][i] - pixels[2][i]) > 5) legacyMismatch++;
    if (pixels[0][i] < 100) colored++;
  }
  // The transparent quadrant must remain transparent within the footprint, not become a colored square.
  for (let y = 65; y < 190; y++) for (let x = 65; x < 190; x++) {
    if (pixels[0][(y * 256 + x) * 4] > 240) transparent++;
  }
  map.dispose(); whiteMap.dispose(); white.dispose();
  return { mismatch, legacyMismatch, colored, transparent };
};

// Rendering while storage grows must match creating the same marks before the first render.
window.checkDecalGrowth = async () => {
  paint.clear();
  const results = [];
  for (const incremental of [false, true]) {
    const material = new THREE.MeshBasicMaterial({ color: '#102040' });
    const view = new DecalRenderer(material, { size: 0.22, inheritColor: 1, maxDecals: 128 });
    const owner = new ParticleSystem({ gpuProcessing: false, emitters: [], renderers: [view] });
    scene.add(owner); scene.updateMatrixWorld(true);
    const target = backend === 'webgl'
      ? new THREE.WebGLRenderTarget(256, 256) : new THREE.RenderTarget(256, 256);
    const capture = async () => {
      renderer.setRenderTarget(target);
      if (renderer.renderAsync) await renderer.renderAsync(scene, camera);
      else renderer.render(scene, camera);
      await fence();
      return new Uint8Array(await renderer.readRenderTargetPixelsAsync(target, 0, 0, 256, 256,
        ...(backend === 'webgl' ? [new Uint8Array(256 * 256 * 4)] : [])));
    };
    for (let i = 0; i < 70; i++) {
      owner._notifySpawn(new Particle({
        position: new THREE.Vector3((i % 10 - 4.5) * 0.25, 0.1, (Math.floor(i / 10) - 3) * 0.25),
        color: new THREE.Color().setHSL(i / 70, 0.8, 0.5), lifetime: 10,
      }));
      if (incremental && [0, 15, 16, 31, 32, 63, 64].includes(i)) await capture();
    }
    const pixels = await capture();
    const repeated = await capture();
    let flicker = 0;
    for (let i = 0; i < pixels.length; i++) if (pixels[i] !== repeated[i]) flicker++;
    results.push({ pixels, flicker, count: view.count });
    renderer.setRenderTarget(null); target.dispose(); owner.destroy(); material.dispose();
  }
  let mismatch = 0;
  for (let i = 0; i < results[0].pixels.length; i++) {
    if (Math.abs(results[0].pixels[i] - results[1].pixels[i]) > 5) mismatch++;
  }
  return { mismatch, flicker: results[1].flicker, count: results[1].count };
};

// A round input mask must stay near the impact at the rear and visibly extend downstream.
window.checkForwardSplat = async (bridge = false) => {
  paint.clear();
  const texels = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const i = (y * 64 + x) * 4;
    texels.set([255, 255, 255, Math.hypot(x - 31.5, y - 31.5) < 30 ? 255 : 0], i);
  }
  const map = new THREE.DataTexture(texels, 64, 64);
  map.needsUpdate = true;
  const material = new THREE.MeshBasicMaterial({ map, color: '#d02010' });
  const results = [];
  for (const amount of bridge ? [1, 1.5] : [1, -1]) {
    const warp = bridge
      ? DecalRenderer.Warp.FromPoints(new THREE.Vector3(), new THREE.Vector3(0.8, 0, 0), 4, amount)
      : DecalRenderer.Warp.FromVelocity(3, 1);
    const view = new DecalRenderer(material, { size: 0.35, warp });
    const owner = new ParticleSystem({ gpuProcessing: false, emitters: [], renderers: [view] });
    scene.add(owner); scene.updateMatrixWorld(true);
    owner._notifySpawn(new Particle({
      position: new THREE.Vector3(0, 0.1, 0), velocity: new THREE.Vector3(2 * amount, -1, 0), lifetime: 10,
    }));
    const target = backend === 'webgl'
      ? new THREE.WebGLRenderTarget(256, 256) : new THREE.RenderTarget(256, 256);
    renderer.setRenderTarget(target);
    if (renderer.renderAsync) await renderer.renderAsync(scene, camera);
    else renderer.render(scene, camera);
    await fence();
    const pixels = new Uint8Array(await renderer.readRenderTargetPixelsAsync(target, 0, 0, 256, 256,
      ...(backend === 'webgl' ? [new Uint8Array(256 * 256 * 4)] : [])));
    let minX = 256, maxX = -1;
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const i = (y * 256 + x) * 4;
      if (pixels[i] > pixels[i + 1] * 2 && pixels[i] > pixels[i + 2] * 2) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      }
    }
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), 256, 256), 0, 0);
    results.push({ minX, maxX, image: canvas.toDataURL('image/png') });
    renderer.setRenderTarget(null); target.dispose(); owner.destroy();
  }
  map.dispose(); material.dispose();
  return results;
};
