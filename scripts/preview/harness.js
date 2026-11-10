import * as THREE from 'three';
import { readTargetPNG } from './readback.utils.mjs';
import { resolveScene } from './resolveScene.mjs';
import { validateGPUChildren } from './validateGPUChildren.js';
import { validateFireflyAttachments } from './validateFireflyAttachments.js';
import { examples } from 'examples/index.js';
import scenePresets from 'examples/scenes/index.js';
import { getSceneParticleRoot } from 'examples/utils/particleRoot.js';
import { createWebGPURenderer } from '../../apps/demo/src/rendering/createWebGPURenderer.js';

/** Browser entry point. Only installed for the demo's explicit ?preview route. */
export function installPreview() {
  window.rzmpsPreview = { capture };
}
async function capture(options) {
  const originalRandom = Math.random;
  let randomState = options.seed >>> 0;
  Math.random = () => {
    randomState += 0x6d2b79f5;
    let t = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let renderer, system, sceneHandle, captureTarget;
  let step = 0;
  let deviceLost;
  const report = (phase, details = {}) => window.rzmpsPreviewReport?.({ phase, step, ...details });
  await report('capture-start', { requestedBackend: options.backend, width: options.width, height: options.height });
  const shaderBindings = [];
  const scene = new THREE.Scene();
  const assetErrors = [];
  const oldOnError = THREE.DefaultLoadingManager.onError;
  THREE.DefaultLoadingManager.onError = url => {
    assetErrors.push(url);
    oldOnError?.(url);
  };
  const camera = new THREE.PerspectiveCamera(options.cameraFov, options.width / options.height, 0.1, 500);
  camera.position.set(...options.cameraPosition);
  camera.lookAt(...options.cameraTarget);
  scene.background = new THREE.Color('#11151f');
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(5, 10, 5);
  try {
    const fixtures = {
      nativeEvents: () => import('../tests/preview/fixtures/nativeEvents.js'),
      eventScopes: () => import('../tests/preview/fixtures/eventScopes.js'),
      gpuKill: () => import('../tests/preview/fixtures/gpuKill.js'),
      simulationSpaces: () => import('../tests/preview/fixtures/simulationSpaces.js'),
    };
    const example = Object.hasOwn(fixtures, options.example)
      ? { create: (await fixtures[options.example]()).default }
      : examples.find(e => e.id === options.example);
    if (!example)
      throw new Error(`Unknown example ${options.example}. Available: ${examples.map(e => e.id).join(', ')}`);
    await report('renderer-init');
    if (options.backend === 'webgpu') {
      if (!navigator.gpu || !(await navigator.gpu.requestAdapter()))
        throw new Error('WebGPU is unavailable; no fallback was attempted');
      renderer = await createWebGPURenderer({ antialias: true, forceWebGL: false });
      if (!renderer.backend.isWebGPUBackend) throw new Error('WebGPU initialization used an unexpected backend');
      const backend = renderer.backend;
      backend.device.lost.then(info => {
        if (info.reason !== 'destroyed') deviceLost = new Error(`WebGPU device lost (${info.reason}): ${info.message}`);
      });
      for (const method of ['createComputePipeline', 'createRenderPipeline']) {
        const original = backend[method].bind(backend);
        backend[method] = (input, ...args) => {
          const pipeline = input.pipeline ?? input;
          for (const program of [pipeline.computeProgram, pipeline.vertexProgram, pipeline.fragmentProgram]) {
            if (!program) continue;
            const storageBuffers = (program.code.match(/var<storage/g) ?? []).length;
            shaderBindings.push({
              stage: program.stage,
              name: program.name || (program.stage === 'compute' ? 'simulation' : 'render'),
              storageBuffers,
            });
            if (storageBuffers > 8) throw new Error(`${program.stage} shader uses ${storageBuffers} storage buffers`);
          }
          return original(input, ...args);
        };
      }
    } else renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    await report('renderer-ready', { actualBackend: renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl' });
    renderer.setPixelRatio(1);
    renderer.setSize(options.width, options.height);
    renderer.shadowMap.enabled = true;
    if (options.backend === 'webgpu') {
      captureTarget = new THREE.RenderTarget(options.width, options.height);
      captureTarget.texture.colorSpace = THREE.SRGBColorSpace;
      renderer.setRenderTarget(captureTarget);
    }
    document.body.replaceChildren(renderer.domElement);
    const sceneFactory = resolveScene(options.scene, example.previewSettings?.scene, scenePresets);
    if (!sceneFactory) scene.add(new THREE.AmbientLight(0xffffff, 0.8), light);
    if (sceneFactory) {
      sceneHandle = await sceneFactory(scene, renderer, camera);
      if (options.sceneLightStrength !== undefined) {
        if (!sceneHandle?.setLightStrength) throw new Error('Selected scene has no light strength control');
        sceneHandle.setLightStrength(options.sceneLightStrength);
      }
    }
    await report('example-init');
    system = await example.create(options.exampleOptions);
    system.traverse(object => {
      for (const view of object.renderers ?? []) {
        if (!Array.isArray(view.lights)) continue;
        const update = view._update.bind(view);
        view._update = particles => {
          for (const p of particles) {
            const values = [...p.position.toArray(), p.time, p.alpha];
            if (values.some(value => !Number.isFinite(value))) {
              throw new Error(`Invalid light source ${p.id}: ${values.join(', ')}`);
            }
          }
          void report('light-update', { particles: particles.length, before: view.lights.length, cap: view.count });
          update(particles);
          void report('light-updated', {
            lights: view.lights.length,
            peak: Math.max(0, ...view.lights.map(l => l.intensity)),
          });
        };
      }
    });
    getSceneParticleRoot(scene).add(system);
    scene.userData.__rzmps_configureParticleSystem?.(system);
    // Avoid built-in prewarm; the CLI specifies the exact initial step count.
    system.traverse(object => {
      if ('prewarm' in object) object.prewarm = false;
    });
    // Most example factories use TextureLoader.load; await its pending work too.
    await report('assets');
    await waitForAssets();
    if (assetErrors.length) throw new Error(`Failed assets: ${assetErrors.join(', ')}`);
    const render = async () => {
      if (deviceLost) throw deviceLost;
      scene.updateMatrixWorld(true);
      if (options.backend === 'webgpu') {
        renderer.setRenderTarget(captureTarget);
        let lights = 0;
        scene.traverse(object => {
          if (object.isLight) lights++;
        });
        await report('shader-compile', { lights });
        await renderer.compileAsync(scene, camera);
        await report('gpu-submit');
        renderer.render(scene, camera);
        await renderer.backend.device.queue.onSubmittedWorkDone();
      } else {
        renderer.render(scene, camera);
        renderer.getContext().finish();
        const error = renderer.getContext().getError();
        if (error !== 0) throw new Error(`WebGL error: ${error}`);
      }
    };
    await report('initial-render');
    await render(); // Establish RZMPS camera/renderer context before the first step.

    async function advance(count) {
      for (let i = 0; i < count; i++) {
        sceneHandle?.update?.(options.deltaTime);
        scene.updateMatrixWorld(true);
        const roots = [];
        scene.traverse(object => {
          if (typeof object.advanceFrames === 'function' && !object.isSubSystem) roots.push(object);
        });
        for (const root of roots) root.advanceFrames(1, options.deltaTime);
        step++;
        // Let asynchronous GPU lifecycle consumers (including persistent decals)
        // observe frames during warmup, as they do in a real animation loop.
        if (options.backend === 'webgpu' && step % 30 === 0) {
          if (deviceLost) throw deviceLost;
          await report('warmup-submit');
          await renderer.backend.device.queue.onSubmittedWorkDone();
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    }
    await report('warmup', { steps: options.warmup });
    await advance(options.warmup);
    await report('warmup-complete');
    const frames = [];
    for (let index = 0; index < options.frames; index++) {
      if (index > 0) await advance(options.interval);
      // Live reflections are renderer work, deferred by advanceFrames, so refresh only for captures.
      system.traverse(object => {
        if (object.useLiveCubemap) {
          const elapsedSteps = index === 0 ? options.warmup : options.interval;
          object.liveCubemap?.update(
            scene,
            renderer,
            Math.max(1 / object.liveCubemap.fps, elapsedSteps * options.deltaTime),
          );
        }
      });
      await report('frame-render', { frame: index });
      await render();
      // Readback-based views such as particle lights finish asynchronously after the render.
      if (options.backend === 'webgpu') {
        const lightRenderers = [];
        system.traverse(object => {
          for (const view of object.renderers ?? []) if (Array.isArray(view.lights)) lightRenderers.push(view);
        });
        if (lightRenderers.length) {
          const deadline = performance.now() + 2000;
          while (lightRenderers.some(view => view._gpuReadbackPending) && performance.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 0));
          }
          await render();
        }
      }
      await report('frame-export', { frame: index });
      const data = captureTarget
        ? await readTargetPNG(renderer, captureTarget, options.width, options.height)
        : renderer.domElement.toDataURL('image/png');
      if (!data.startsWith('data:image/png;base64,')) throw new Error('Canvas PNG export failed');
      // Preview metadata is an explicit observation, so inspect GPU state rather
      // than reporting the runtime diagnostic's intentionally delayed count.
      const gpuCounts = new Map();
      if (options.backend === 'webgpu') {
        const pending = [];
        system.traverse(object => {
          const buffers = object.gpuParticleBuffers;
          if (!object.isGPUProcessingActive || !buffers) return;
          pending.push(
            renderer.getArrayBufferAsync(buffers.attributes.uintData).then(buffer => {
              const states = new Uint32Array(buffer);
              let count = 0;
              for (let slot = 0; slot < buffers.count; slot++) if (states[slot * 4]) count++;
              gpuCounts.set(object, count);
            }),
          );
        });
        await report('particle-readback', { frame: index, buffers: pending.length });
        await Promise.all(pending);
      }
      let particles = 0;
      const systems = [];
      system.traverse(object => {
        if (!Array.isArray(object.particles)) return;
        const simulated = gpuCounts.get(object) ?? object.liveParticleCount;
        particles += simulated;
        const lights = object.renderers.flatMap(view => (Array.isArray(view.lights) ? view.lights : []));
        systems.push({
          name: object.name,
          quality: object.quality,
          gpuProcessingActive: object.isGPUProcessingActive,
          simulated,
          events: object.gpuEventStats,
          lights: {
            count: lights.length,
            active: lights.filter(light => light.intensity > 0).length,
            peakIntensity: Math.max(0, ...lights.map(light => light.intensity)),
          },
        });
        for (const particle of object.particles) {
          const values = [
            ...particle.position.toArray(),
            ...particle.velocity.toArray(),
            ...particle.scale.toArray(),
            particle.alpha,
          ];
          if (values.some(value => !Number.isFinite(value))) {
            throw new Error(`Non-finite particle state in ${object.name || 'system'}: ${values.join(', ')}`);
          }
        }
      });
      const attachmentValidation =
        options.example === 'fireflies' ? await validateFireflyAttachments(system) : undefined;
      frames.push({
        data,
        systems,
        attachmentValidation,
        time: step * options.deltaTime,
        step,
        particles,
        simulationSpeed: system.simulationSpeed,
        simulatedSeconds: step * options.deltaTime * Math.max(0, system.simulationSpeed),
      });
    }
    await report('validation');
    const childValidation = options.backend === 'webgpu' ? await validateGPUChildren(system, renderer) : [];
    const frameValidation = (await system.userData.validateSimulationFrames?.(renderer)) ?? [];
    const contactSheet = await makeContactSheet(frames, options);
    await report('complete');
    return {
      backend: renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl',
      frames,
      contactSheet,
      shaderBindings,
      childValidation,
      frameValidation,
      scene: options.scene ?? sceneFactory?.name ?? null,
      camera: { position: camera.position.toArray(), target: options.cameraTarget, fov: options.cameraFov },
      rendererInfo: { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles },
      userAgent: navigator.userAgent,
      assetErrors,
    };
  } finally {
    try {
      system?.destroy();
      if (typeof sceneHandle === 'function') sceneHandle();
      else sceneHandle?.cleanup?.();
      captureTarget?.dispose();
      renderer?.dispose();
    } finally {
      THREE.DefaultLoadingManager.onError = oldOnError;
      Math.random = originalRandom;
    }
  }
}
// Track all loader activity, including TextureLoader.load calls that factories do not await.
let pendingAssets = 0;
const originalStart = THREE.DefaultLoadingManager.itemStart.bind(THREE.DefaultLoadingManager);
const originalEnd = THREE.DefaultLoadingManager.itemEnd.bind(THREE.DefaultLoadingManager);
THREE.DefaultLoadingManager.itemStart = url => {
  pendingAssets++;
  originalStart(url);
};
THREE.DefaultLoadingManager.itemEnd = url => {
  pendingAssets--;
  originalEnd(url);
};
async function waitForAssets() {
  const deadline = performance.now() + 30000;
  while (pendingAssets > 0) {
    if (performance.now() > deadline) throw new Error('Timed out loading example assets');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function makeContactSheet(frames, options) {
  const columns = Math.min(3, frames.length),
    rows = Math.ceil(frames.length / columns),
    labelHeight = 30;
  const canvas = document.createElement('canvas');
  canvas.width = columns * options.width;
  canvas.height = rows * (options.height + labelHeight);
  const context = canvas.getContext('2d');
  context.fillStyle = '#11151f';
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (const [index, frame] of frames.entries()) {
    const image = new Image();
    image.src = frame.data;
    await image.decode();
    const x = (index % columns) * options.width,
      y = Math.floor(index / columns) * (options.height + labelHeight);
    context.drawImage(image, x, y);
    context.fillStyle = '#fff';
    context.font = '16px sans-serif';
    context.fillText(
      `Frame ${index} | ${frame.time.toFixed(3)} s | step ${frame.step}`,
      x + 10,
      y + options.height + 21,
    );
  }
  return canvas.toDataURL('image/png');
}
