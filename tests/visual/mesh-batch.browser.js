import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { Fn, If, float, uint, vec4 } from 'three/tsl';
import {
  Collision, Emitter, EmissionShape, MeshRenderer, SpriteRenderer, Particle, ParticleSystem,
  createGPUParticleBufferState, GPUEmissionRunBufferState, Textures,
} from '@rzmps/rzmps';

import { ParticleSystemSerializer } from '../../apps/demo/src/gui/particle-system-gui/ParticleSystemSerializer';

window.checkRendererSerialization = () => {
  const geometry = new THREE.BoxGeometry().toNonIndexed();
  const material = new THREE.MeshStandardMaterial();
  const sources = [new THREE.Mesh(geometry, material), new THREE.Mesh(new THREE.SphereGeometry(), material)];
  const mesh = new MeshRenderer({ mesh: { rock: { fracture: sources } }, maxParticles: 7, meshIndex: 1,
    materialCopySampleMode: 1 });
  const sprites = new SpriteRenderer({ rock: { fracture: [Textures.Circle, Textures.Simple] } },
    { textureIndex: 1, materialCopySampleMode: 1 });
  const serializer = new ParticleSystemSerializer({});
  const options = new Function(`return ${serializer.serializeSubSystemOptions({
    copyCollisionMaterial: true, impulseAffectsCount: 0.5,
  })}`)();
  const restored = [mesh, sprites].map(view => new Function('THREE', 'MeshRenderer', 'SpriteRenderer', 'Textures',
    `return ${serializer.serializeRenderer(view)}`)(THREE, MeshRenderer, SpriteRenderer, Textures));
  try {
    if (!restored[0].instances.isBatchedMesh || restored[0].maxParticles !== 7
      || restored[0].meshes.length !== 2 || restored[0].meshIndex !== 1
      || restored[0].meshes[0].geometry.getAttribute('position').count !== geometry.getAttribute('position').count
      || restored.some(view => view.materialCopySampleMode !== 1)
      || restored.some(view => JSON.stringify(view.selectionTags) !== '["rock","fracture"]')
      || restored[1].textureIndex !== 1
      || !options.copyCollisionMaterial || options.impulseAffectsCount !== 0.5
      || !serializer.rendererUsesBuiltInTexture(sprites)) {
      throw new Error('Renderer serialization lost geometry choices, tags, capacity or material copying');
    }
    return true;
  } finally {
    [mesh, sprites, ...restored].forEach(view => view.destroy());
    sources.forEach(source => source.geometry.dispose());
    material.dispose();
  }
};

window.checkMeshBatch = async (backend, kind = 'flat') => {
  const renderer = backend === 'webgpu' ? new WebGPURenderer() : new THREE.WebGLRenderer();
  renderer.setSize(64, 32);
  if (backend === 'webgpu') {
    await renderer.init();
    if (!renderer.backend.isWebGPUBackend) throw new Error('Native WebGPU unavailable');

  }
  const textures = [[255, 0, 0, 255], [0, 0, 255, 255]].map(values => {
    const map = new THREE.DataTexture(new Uint8Array(values), 1, 1);
    map.needsUpdate = true;
    return map;
  });
  const meshes = textures.map((map, i) => new THREE.Mesh(
    i ? new THREE.SphereGeometry(0.5, 12, 8) : new THREE.BoxGeometry(),
    new THREE.MeshBasicMaterial({ map }),
  ));
  const tagged = kind !== 'flat';
  const choices = resources => ({ outer: {
    red: [resources[0], { extra: resources[1] }], blue: [resources[1]],
  } });
  const view = kind === 'sprites'
    ? new SpriteRenderer(choices(textures), { billboard: false, textureIndex: t => t })
    : new MeshRenderer({ mesh: tagged ? choices(meshes) : meshes, meshIndex: t => t, maxParticles: 1 });
  const system = new ParticleSystem({ emitters: [], renderers: view });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0);
  scene.add(system);
  system._prepareGPUTagRegistry([]);
  const camera = new THREE.OrthographicCamera(-2, 2, 1, -1, 0.1, 10);
  camera.position.z = 5;
  const target = new THREE.WebGLRenderTarget(64, 32);
  const particles = [0, 1].map(time => {
    const particle = new Particle({ lifetime: 10, alpha: 0.5 });
    particle.position.x = time * 2 - 1;
    particle.time = time;
    particle.tags = ['outer', time ? 'blue' : 'red'];
    return particle;
  });
  let buffers;

  const pixels = async () => {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const data = new Uint8Array(64 * 32 * 4);
    if (backend === 'webgpu') return renderer.readRenderTargetPixelsAsync(target, 0, 0, 64, 32);
    renderer.readRenderTargetPixels(target, 0, 0, 64, 32, data);
    return data;
  };
  const sample = (data, x) => Array.from(data.slice((16 * 64 + x) * 4, (16 * 64 + x) * 4 + 4));
  const check = async (label, hiddenRed = false) => {
    const data = await pixels();
    const red = sample(data, 16), blue = sample(data, 48);
    if (!((hiddenRed ? red[0] < 5 : red[0] > 70 && red[0] < 240) && red[1] < 5 && red[2] < 5
      && blue[2] > 70 && blue[2] < 240 && blue[0] < 5 && blue[1] < 5)) {
      throw new Error(`${backend} ${kind} ${label}: incorrect atlas/selection/alpha: ${JSON.stringify({ red, blue })}`);
    }
    return { label, red, blue };
  };

  try {
    await pixels(); // Capture scene renderer context before the first renderer update.
    view.update(particles, system);
    const results = [await check('CPU')];
    if (tagged) {
      particles[0].tags = ['red'];
      view.update(particles, system);
      results.push(await check('CPU missing outer tag', true));
      particles[0].tags = ['outer', 'red', 'blue'];
      view.update(particles, system);
      results.push(await check('CPU first matching key'));
    }
    if (backend === 'webgpu') {
      const mask = particle => system.getGPURendererTagMask(particle.tags) ?? 0;
      buffers = createGPUParticleBufferState(particles, 2, mask);
      buffers.initialize(renderer);
      view.updateGPU(buffers, system);
      results.push(await check('GPU'));
      if (tagged) {
        particles[0].tags = ['red'];
        buffers.upload(particles, mask);
        view.updateGPU(buffers, system);
        results.push(await check('GPU missing outer tag', true));
        particles[0].tags = ['outer', 'red', 'blue'];
        buffers.upload(particles, mask);
      }

      // Exercise compact renderer output, draw-capacity growth and child slot addressing.
      view.children = { count: 1, radius: 0 };
      view.syncGPUConfiguration();
      view.updateGPU(buffers, system);
      const childPixels = await pixels();
      const red = sample(childPixels, 16), blue = sample(childPixels, 48);
      if (!(red[0] >= 180 && red[2] < 5 && blue[2] >= 180 && blue[0] < 5)) {
        throw new Error(`Renderer children lost their mesh/alpha bindings: ${JSON.stringify({ red, blue })}`);
      }
      results.push({ label: 'GPU children', red, blue });
      view.children = {};
      view.syncGPUConfiguration();
      view.update(particles, system);
      results.push(await check('CPU after GPU'));
    }
    return results;
  } finally {
    renderer.setRenderTarget(null);
    system.destroy();
    buffers?.dispose(renderer);
    meshes.forEach(mesh => { mesh.geometry.dispose(); mesh.material.dispose(); });
    textures.forEach(map => map.dispose());
    target.dispose();
    renderer.dispose();
  }
};

// Compare a copied contact sample with Three.js sampling the original map at the identical UV.
window.checkMaterialCopyUV = async (backend, batched = true) => {
  const renderer = backend === 'webgpu' ? new WebGPURenderer() : new THREE.WebGLRenderer();
  renderer.setSize(64, 32);
  if (backend === 'webgpu') await renderer.init();

  const map = new THREE.DataTexture(new Uint8Array([
    230, 230, 230, 255, 45, 45, 45, 255,
    45, 45, 45, 255, 230, 230, 230, 255,
  ]), 2, 2);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(20, 20);
  map.magFilter = map.minFilter = THREE.NearestFilter;
  map.needsUpdate = true;
  const source = new THREE.MeshBasicMaterial({ map });
  const template = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
  const view = new MeshRenderer({ mesh: batched ? [template, template] : template, maxParticles: 1 });
  const system = new ParticleSystem({ emitters: [], renderers: view });
  const scene = new THREE.Scene();
  scene.add(system);
  const reference = new THREE.Mesh(new THREE.PlaneGeometry(), source);
  reference.position.x = -1;
  scene.add(reference);
  const camera = new THREE.OrthographicCamera(-2, 2, 1, -1, 0.1, 10);
  camera.position.z = 5;
  const target = new THREE.WebGLRenderTarget(64, 32);
  const particle = new Particle({ lifetime: 10 });
  particle.position.x = 1;
  const id = system.materialCopyRegistry.register(source);
  const results = [];
  let buffers;
  // A nondegenerate chart also exercises UVPatch at the fragment's center.
  particle.materialCopyU.set(0.001, 0, 0, 0);
  particle.materialCopyV.set(0, 0.001, 0, 0);

  try {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const phases = backend === 'webgpu' ? ['CPU', 'GPU'] : ['CPU'];
    for (const phase of phases) {
      if (phase === 'GPU') {
        buffers = createGPUParticleBufferState([particle], 1);
        buffers.initialize(renderer);
      }
      for (const mode of [0, 1]) {
        view.materialCopySampleMode = mode;
        for (const uv of [[0.5125, 0.5125], [0.5375, 0.5125], [0.5125, 0.5375]]) {
          const attr = reference.geometry.getAttribute('uv');
          for (let i = 0; i < attr.count; i++) attr.setXY(i, ...uv);
          attr.needsUpdate = true;
          particle.materialCopy.set(id, ...uv, mode);
          if (phase === 'GPU') {
            // Simulate GPU-owned contact updates, rather than uploading CPU storage during a draw.
            renderer.compute(Fn(() => {
              buffers.storage.createParticle(uint(0)).materialCopy.assign(vec4(id, ...uv, mode));
            })().compute(1));
            view.updateGPU(buffers, system);
          } else view.update([particle], system);
          renderer.setRenderTarget(target);
          renderer.render(scene, camera);
          let pixels = new Uint8Array(64 * 32 * 4);
          if (backend === 'webgpu') pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 64, 32);
          else renderer.readRenderTargetPixels(target, 0, 0, 64, 32, pixels);
          const sample = x => Array.from(pixels.slice((16 * 64 + x) * 4, (16 * 64 + x) * 4 + 3));
          const expected = sample(16), actual = sample(48);
          results.push({ phase, mode, uv, expected, actual });
          if (expected.some((v, i) => Math.abs(v - actual[i]) > 3)) {
            throw new Error(`${backend} copied UV sample mismatch: ${JSON.stringify(results)}`);
          }
        }
      }
    }
    return results;
  } finally {
    renderer.setRenderTarget(null);
    system.destroy();
    buffers?.dispose(renderer);
    reference.geometry.dispose();
    template.geometry.dispose();
    template.material.dispose();
    source.dispose();
    map.dispose();
    target.dispose();
    renderer.dispose();
  }
};


window.checkGPUEmissionRuns = async () => {
  const renderer = new WebGPURenderer();
  await renderer.init();
  const runs = new GPUEmissionRunBufferState(1);
  runs.initialize(renderer);
  const advance = Fn(() => {
    const run = runs.load(0);
    If(run.active.notEqual(uint(0)), () => run.elapsed.addAssign(float(0.1)));
  })().compute(1);
  const retire = Fn(() => {
    const run = runs.load(0);
    If(run.active.notEqual(uint(0)).and(run.elapsed.greaterThanEqual(run.duration)), () => {
      run.active.assign(uint(0));
    });
  })().compute(1);
  const snapshots = [new Particle()];

  try {
    // Reuse one slot repeatedly: a local-only elapsed/active update permanently exhausts this pool.
    for (let generation = 1; generation <= 8; generation++) {
      const begin = Fn(() => {
        const run = runs.load(0);
        If(run.active.equal(uint(0)), () => runs.storeParticle(uint(0), {
          ...run.particle, alive: uint(1), realtime: float(0), lifetime: float(0.05), generation: uint(generation),
        }));
      })().compute(1);
      renderer.compute(begin);
      renderer.compute(advance);
      renderer.compute(retire);
      await runs.snapshots.readback(renderer, snapshots);
      begin.dispose();
      if (snapshots[0].alive || Math.abs(snapshots[0].realtime - 0.1) > 1e-6
        || runs.snapshots.uintData[2] !== generation) {
        throw new Error(`Emission run ${generation} did not advance, retire and release its GPU slot`);
      }
    }
    return true;
  } finally {
    advance.dispose();
    retire.dispose();
    runs.snapshots.dispose(renderer);
    renderer.dispose();
  }
};


window.checkImpulseCountEmission = async backend => {
  const renderer = backend === 'webgpu' ? new WebGPURenderer() : new THREE.WebGLRenderer();
  renderer.setSize(16, 16);
  if (backend === 'webgpu') await renderer.init();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 10);
  camera.position.set(0, 1, 2);
  camera.lookAt(0, 0, 0);
  const results = [];

  try {
    for (const [impulse, effect, expected] of [[0.36, 0.5, 11], [1.44, 0.5, 23], [5.76, 0.5, 47], [4, 0, 20]]) {
      const scene = new THREE.Scene();
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicMaterial());
      floor.rotation.x = -Math.PI / 2;
      scene.add(floor);
      const view = () => new MeshRenderer({ maxParticles: 128, material: new THREE.MeshBasicMaterial() });
      const parent = new ParticleSystem({ gpuProcessing: backend === 'webgpu', maxParticles: 4,
        gravityModifier: 0, duration: 3, looping: false,
        emitters: new Emitter({ source: EmissionShape.Sphere(0.01),
          rate: 0, bursts: [{ time: 0, count: 1 }], radialSpeed: 0,
          initialValues: { position: new THREE.Vector3(0.5, 0.3, 0.25), velocity: new THREE.Vector3(0, -2, 0),
            scale: 0.1, mass: impulse / 2, lifetime: 3 } }),
        modules: new Collision({ bounce: 0, dampen: 0 }), renderers: view(),
      });
      const child = new ParticleSystem({ gpuProcessing: backend === 'webgpu', maxParticles: 128,
        gravityModifier: 0, duration: 1, looping: false,
        emitters: new Emitter({ rate: 16, radialSpeed: 0, bursts: [{ time: 0, count: 8 }],
          initialValues: { lifetime: 10, scale: 0.01 } }), renderers: view(),
      });
      parent.addSubSystem(child, { emitOnCollision: true, inheritLifetime: 0, impulseAffectsCount: effect });
      scene.add(parent);
      try {
        renderer.render(scene, camera);
        parent.advanceFrames(16, 0.125);
        let count;
        if (backend === 'webgpu') {
          if (!parent.isGPUProcessingActive || !child.isGPUProcessingActive) throw new Error('GPU fallback');
          const snapshots = Array.from({ length: child._gpuBuffers.count }, () => new Particle());
          await child._gpuBuffers.readback(renderer, snapshots);
          count = snapshots.filter(particle => particle.alive).length;
        } else count = child.particles.filter(particle => particle.alive).length;
        results.push({ impulse, effect, expected, count });
        if (count !== expected) throw new Error(`${backend} impulse counts: ${JSON.stringify(results)}`);
      } finally {
        parent.destroy();
        floor.geometry.dispose();
        floor.material.dispose();
      }
    }
    return results;
  } finally {
    renderer.dispose();
  }
};
