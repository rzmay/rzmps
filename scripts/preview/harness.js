import * as THREE from 'three';
import { validateGPUChildren } from './validateGPUChildren.js';
import { examples } from '../../examples/index.js';
import scenePresets from '../../apps/demo/src/presets/scenes/index.js';
import { getSceneParticleRoot } from '../../apps/demo/src/presets/scenes/particleRoot.js';
import { createWebGPURenderer } from '../../apps/demo/src/rendering/createWebGPURenderer.js';

/** Browser entry point. Only installed for the demo's explicit ?preview route. */
export function installPreview() {
  window.rzmpsPreview = { capture };
}
async function capture(options) {
  const originalRandom = Math.random;
  let randomState = options.seed >>> 0;
  Math.random = () => {
    randomState += 0x6D2B79F5;
    let t = Math.imul(randomState ^ randomState >>> 15, 1 | randomState);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  let renderer, system, sceneHandle;
  const shaderBindings = [];
  const scene = new THREE.Scene();
  const assetErrors = [];
  const oldOnError = THREE.DefaultLoadingManager.onError;
  THREE.DefaultLoadingManager.onError = url => { assetErrors.push(url); oldOnError?.(url); };
  const camera = new THREE.PerspectiveCamera(options.cameraFov, options.width / options.height, 0.1, 500);
  camera.position.set(...options.cameraPosition);
  camera.lookAt(...options.cameraTarget);
  scene.background = new THREE.Color('#11151f');
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(5,10,5);
  if (!options.scene) scene.add(new THREE.AmbientLight(0xffffff, 0.8),light);
  try {
    const fixtures = {
      nativeEvents: () => import('../../tests/visual/fixtures/nativeEvents.js'),
      gpuKill: () => import('../../tests/visual/fixtures/gpuKill.js'),
    };
    const example = Object.hasOwn(fixtures, options.example)
      ? { create: (await fixtures[options.example]()).default }
      : examples.find(e => e.id === options.example);
    if (!example) throw new Error(`Unknown example ${options.example}. Available: ${examples.map(e=>e.id).join(', ')}`);
    if (options.backend === 'webgpu') {
      if (!navigator.gpu ||
        !await navigator.gpu.requestAdapter()) throw new Error('WebGPU is unavailable; no fallback was attempted');
      renderer = await createWebGPURenderer({ antialias:true, forceWebGL:false });
      if (!renderer.backend.isWebGPUBackend) throw new Error('WebGPU initialization used an unexpected backend');
      const backend = renderer.backend;
      for (const method of ['createComputePipeline', 'createRenderPipeline']) {
        const original = backend[method].bind(backend);
        backend[method] = (input, ...args) => {
          const pipeline = input.pipeline ?? input;
          for (const program of [pipeline.computeProgram, pipeline.vertexProgram, pipeline.fragmentProgram]) {
            if (!program) continue;
            const storageBuffers = (program.code.match(/var<storage/g) ?? []).length;
            shaderBindings.push({ stage: program.stage, name: program.name || (program.stage ===
              'compute' ? 'simulation' : 'render'), storageBuffers });
            if (storageBuffers > 8) throw new Error(`${program.stage} shader uses ${storageBuffers} storage buffers`);
          }
          return original(input, ...args);
        };
      }
    } else renderer = new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
    renderer.setPixelRatio(1);
    renderer.setSize(options.width,options.height);
    renderer.shadowMap.enabled = true;
    document.body.replaceChildren(renderer.domElement);
    if (options.scene) {
      const factory=scenePresets[options.scene];
      if (!factory) throw new Error(`Unknown scene ${options.scene}`);
      sceneHandle=await factory(scene,renderer,camera);
      if (options.sceneLightStrength !== undefined) {
        if (!sceneHandle?.setLightStrength) throw new Error('Selected scene has no light strength control');
        sceneHandle.setLightStrength(options.sceneLightStrength);
      }
    }
    system = await example.create();
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
          update(particles);
        };
      }
    });
    getSceneParticleRoot(scene).add(system);
    scene.userData.__rzmps_configureParticleSystem?.(system);
    // Avoid built-in prewarm; the CLI specifies the exact initial step count.
    system.traverse(object=>{if('prewarm' in object) object.prewarm=false;});
    // Most example factories use TextureLoader.load; await its pending work too.
    await waitForAssets();
    if(assetErrors.length)throw new Error(`Failed assets: ${assetErrors.join(', ')}`);
    const render = async () => {
      scene.updateMatrixWorld(true);
      if(options.backend==='webgpu') {
        renderer.render(scene,camera);
        await renderer.backend.device.queue.onSubmittedWorkDone();
      } else {
        renderer.render(scene,camera);
        renderer.getContext().finish();
        const error=renderer.getContext().getError();
        if(error!==0)throw new Error(`WebGL error: ${error}`);
      }
    };
    await render(); // Establish RZMPS camera/renderer context before the first step.
    let step=0;
    async function advance(count) {
      for(let i=0;i<count;i++){
        sceneHandle?.update?.(options.deltaTime);
        scene.updateMatrixWorld(true);
        const roots=[];
        scene.traverse(object=>{if(typeof object.advanceFrames==='function'&&!object.isSubSystem)roots.push(object);});
        for(const root of roots)root.advanceFrames(1,options.deltaTime);
        step++;
        // Let asynchronous GPU lifecycle consumers (including persistent decals)
        // observe frames during warmup, as they do in a real animation loop.
        if (options.backend === 'webgpu' && step % 30 === 0) {
          await renderer.backend.device.queue.onSubmittedWorkDone();
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    }
    await advance(options.warmup);
    const frames=[];
    for(let index=0;index<options.frames;index++) {
      if(index>0)await advance(options.interval);
      // Live reflections are renderer work, deferred by advanceFrames, so refresh only for captures.
      system.traverse(object=>{
        if(object.useLiveCubemap) {
          const elapsedSteps=index===0?options.warmup:options.interval;
          object.liveCubemap?.update(scene,renderer,Math.max(1/object.liveCubemap.fps,elapsedSteps*options.deltaTime));
        }
      });
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
      const data=renderer.domElement.toDataURL('image/png');
      if(!data.startsWith('data:image/png;base64,'))throw new Error('Canvas PNG export failed');
      // Preview metadata is an explicit observation, so inspect GPU state rather
      // than reporting the runtime diagnostic's intentionally delayed count.
      const gpuCounts = new Map();
      if (options.backend === 'webgpu') {
        const pending = [];
        system.traverse(object => {
          const buffers = object.gpuParticleBuffers;
          if (!object.isGPUProcessingActive || !buffers) return;
          pending.push(renderer.getArrayBufferAsync(buffers.attributes.uintData).then(buffer => {
            const states = new Uint32Array(buffer);
            let count = 0;
            for (let slot = 0; slot < buffers.count; slot++) if (states[slot * 4]) count++;
            gpuCounts.set(object, count);
          }));
        });
        await Promise.all(pending);
      }
      let particles=0;
      const systems = [];
      system.traverse(object=>{
        if(!Array.isArray(object.particles))return;
        const simulated = gpuCounts.get(object) ?? object.liveParticleCount;
        particles += simulated;
        const lights = object.renderers.flatMap(view => Array.isArray(view.lights) ? view.lights : []);
        systems.push({ name: object.name, quality: object.quality,
          gpuProcessingActive: object.isGPUProcessingActive, simulated, events: object.gpuEventStats,
          lights: { count: lights.length, active: lights.filter(light => light.intensity > 0).length,
            peakIntensity: Math.max(0, ...lights.map(light => light.intensity)) } });
        for(const particle of object.particles) {
          const values=[...particle.position.toArray(),...particle.velocity.toArray(),...particle.scale.toArray(),
            particle.alpha];
          if(values.some(value=>
            !Number.isFinite(value))) {
            throw new Error(`Non-finite particle state in ${object.name || 'system'}: ${values.join(', ')}`);
          }
        }
      });
      frames.push({data,systems,time:step*options.deltaTime,step,particles,simulationSpeed:system.simulationSpeed,
        simulatedSeconds:step*options.deltaTime*Math.max(0,system.simulationSpeed)});
    }
    const childValidation = options.backend === 'webgpu' ? await validateGPUChildren(system, renderer) : [];
    const contactSheet=await makeContactSheet(frames,options);
    return {frames,contactSheet,shaderBindings,childValidation,camera:{position:camera.position.toArray(),
      target:options.cameraTarget,fov:options.cameraFov},rendererInfo:{calls:renderer.info.render.calls,
      triangles:renderer.info.render.triangles},userAgent:navigator.userAgent,assetErrors};
  } finally {
    try {
      system?.destroy();
      if(typeof sceneHandle==='function')sceneHandle();else sceneHandle?.cleanup?.();
      renderer?.dispose();
    } finally {
      THREE.DefaultLoadingManager.onError=oldOnError;
      Math.random=originalRandom;
    }
  }
}
// Track all loader activity, including TextureLoader.load calls that factories do not await.
let pendingAssets=0;
const originalStart=THREE.DefaultLoadingManager.itemStart.bind(THREE.DefaultLoadingManager);
const originalEnd=THREE.DefaultLoadingManager.itemEnd.bind(THREE.DefaultLoadingManager);
THREE.DefaultLoadingManager.itemStart=(url)=>{pendingAssets++;originalStart(url);};
THREE.DefaultLoadingManager.itemEnd=(url)=>{pendingAssets--;originalEnd(url);};
async function waitForAssets(){
  const deadline=performance.now()+30000;
  while(pendingAssets>0){
    if(performance.now()>deadline)throw new Error('Timed out loading example assets');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
}
async function makeContactSheet(frames,options) {
  const columns=Math.min(3,frames.length),rows=Math.ceil(frames.length/columns),labelHeight=30;
  const canvas=document.createElement('canvas');
  canvas.width=columns*options.width;canvas.height=rows*(options.height+labelHeight);
  const context=canvas.getContext('2d');
  context.fillStyle='#11151f';context.fillRect(0,0,canvas.width,canvas.height);
  for(const [index,frame]of frames.entries()){
    const image=new Image();image.src=frame.data;await image.decode();
    const x=index%columns*options.width,y=Math.floor(index/columns)*(options.height+labelHeight);
    context.drawImage(image,x,y);
    context.fillStyle='#fff';context.font='16px sans-serif';
    context.fillText(`Frame ${index} | ${frame.time.toFixed(3)} s | step ${frame.step}`,x+10,y+options.height+21);
  }
  return canvas.toDataURL('image/png');
}
