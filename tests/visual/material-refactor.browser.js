import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { If, vec2, vec3, vec4 } from 'three/tsl';
import { Particle, ParticleSystem, Emitter, Module, Collision, MeshRenderer, SpriteRenderer, DecalRenderer,
  MaterialCopy, MaterialCopySource, MaterialCopySampleMode, EmissionShape, AudioRenderer, TextureAtlas, LiveCubemap } from '@rzmps/rzmps';

window.checkMaterialComposite = async (backend, kind) => {
  const renderer = backend === 'webgpu' ? new WebGPURenderer() : new THREE.WebGLRenderer();
  renderer.setSize(64, 32);
  if (backend === 'webgpu') await renderer.init();
  const map = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]), 2, 1);
  map.minFilter = map.magFilter = THREE.NearestFilter;
  map.needsUpdate = true;
  const destMap = new THREE.DataTexture(new Uint8Array([
    0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
  ]), 4, 1);
  destMap.minFilter = destMap.magFilter = THREE.NearestFilter;
  destMap.needsUpdate = true;
  const source = new THREE.MeshStandardMaterial({ map, opacity: 0.5, roughness: 0.25, metalness: 0.75 });
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 0.5, -0.5, 0.01, 10);
  camera.position.z = 5;
  const parameters = { map: destMap, transparent: true, blending: THREE.NoBlending };
  const view = kind === 'sprite' ? new SpriteRenderer(destMap,
    { billboard: false, materialOptions: { transparent: true, blending: THREE.NoBlending } }) : kind === 'decal'
    ? new DecalRenderer(new THREE.MeshBasicMaterial(parameters), { direction: new THREE.Vector3(0, 0, -1),
      maxDistance: 1, depth: 0.5, size: 1, inheritScale: 0 })
    : new MeshRenderer({ geometry: new THREE.PlaneGeometry(1, 1), material: new THREE.MeshBasicMaterial(parameters),
      maxParticles: 2 });
  if (kind === 'sprite') { view.texture.needsUpdate = true; view.randomStartFrame = false; }
  const system = new ParticleSystem({ emitters: [], renderers: view });
  scene.add(system);
  let floor;
  if (kind === 'decal') {
    floor = new THREE.Mesh(new THREE.PlaneGeometry(2, 1), new THREE.MeshBasicMaterial({ color: 0 }));
    floor.position.z = -0.1;
    scene.add(floor);
  }
  const target = new THREE.WebGLRenderTarget(64, 32);
  const particle = new Particle({ lifetime: 10, position: new THREE.Vector3(0, 0, 0.1) });
  const id = system.materialCopyRegistry.register(source);
  const results = [];
  const callbacks = {
    source: [(s, d) => ({ color: s.color, opacity: d.opacity }), (s, d) => ({ color: s.color, opacity: d.opacity })],
    lazy: [(s, d, c) => ({ color: c.sampleSource('color', `(${c.sourceUV} + vec2(0.5, 0.0))`) }),
      (s, d, c) => ({ color: c.sampleSource('color', c.sourceUV.add(vec2(0.5, 0))) })],
    repeat: [(s, d, c) => {
      c.function('halfColor', 'vec3 halfColor(vec3 c) { return c * 0.5; }');
      c.function('halfColor', 'vec3 halfColor(vec3 c) { return c * 0.5; }');
      return { color: `halfColor(${s.color} + ${c.sampleSource('color', 'vec2(0.75, 0.5)')})` };
    }, (s, d, c) => ({ color: s.color.add(c.sampleSource('color', vec2(0.75, 0.5))).mul(0.5) })],
    channels: [(s, d) => ({ color: `vec3(${s.roughness}, ${s.metalness}, ${s.opacity})`, normal: d.normal }),
      (s, d) => ({ color: vec3(s.roughness, s.metalness, s.opacity), normal: d.normal })],
    opacity: [(s) => ({ color: s.color, opacity: '0.25' }), (s) => ({ color: s.color, opacity: vec3(0.25).x })],
    fallback: [(s) => ({ color: s.color }), (s) => ({ color: s.color })],
    invalid: [(s) => ({ color: s.color }), (s) => ({ color: s.color })],
    dest: [(_s, _d, c) => ({ color: c.sampleDest('color', 'vec2(0.9, 0.5)') }),
      (_s, _d, c) => ({ color: c.sampleDest('color', vec2(0.9, 0.5)) })],
    defaults: [undefined, undefined],
  };
  const expected = { source: [255, 0, 0, 255], lazy: [0, 0, 255, 255], repeat: [128, 0, 128, 255],
    channels: [64, 191, 128, 255], opacity: [255, 0, 0, 64], fallback: kind === 'decal' ? [0, 0, 0, 255] : [0, 255, 0, 255],
    invalid: [0, 255, 0, 255], dest: [0, 0, 255, 255], defaults: [0, 0, 0, 128] };

  try {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    for (const name of ['channels', ...Object.keys(callbacks).filter(n => n !== 'channels')]) {
      particle.color.set(0xffffff);
      view.materialComposite = callbacks[name][0];
      view.materialCompositeGPU = callbacks[name][1];
      particle.materialCopy.set(name === 'fallback' ? 0 : name === 'invalid' ? 9999 : id, 0.25, 0.5, 1);
      if (kind === 'decal') {
        view.clear();
        view.update([], system, 0);
        system._notifySpawn(particle);
      } else view.update([particle], system);
      renderer.setRenderTarget(target);
      if (backend === 'webgpu') {
        renderer.backend.device.pushErrorScope('validation');
        await renderer.compileAsync(scene, camera);
      }
      renderer.render(scene, camera);
      if (backend === 'webgpu') await renderer.backend.device.queue.onSubmittedWorkDone();
      let pixels = new Uint8Array(64 * 32 * 4);
      if (backend === 'webgpu') pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 64, 32);
      else renderer.readRenderTargetPixels(target, 0, 0, 64, 32, pixels);
      const pixel = Array.from(pixels.slice((16 * 64 + 32) * 4, (16 * 64 + 32) * 4 + 4));
      if (backend === 'webgpu') {
        const error = await renderer.backend.device.popErrorScope();
        if (error) throw new Error(error.message);
      }
      results.push({ name, pixel });
      if (pixel.some((v, i) => Math.abs(v - expected[name][i]) > 3)) {
        throw new Error(`${backend} ${kind} composite: ${JSON.stringify(results)}`);
      }
    }
    return results;
  } finally {
    renderer.setRenderTarget(null);
    system.destroy();
    floor?.geometry.dispose(); floor?.material.dispose();
    map.dispose(); destMap.dispose(); source.dispose(); target.dispose(); renderer.dispose();
  }
};

window.checkNativeInitialization = async () => {
  const renderer = new WebGPURenderer();
  await renderer.init();
  renderer.setSize(16, 16);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 20);
  camera.position.set(0, 1, 4);
  const floorMaterial = new THREE.MeshStandardMaterial({ color: 0xff0000 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const parent = new ParticleSystem({ gpuProcessing: true, maxParticles: 8, gravityModifier: 0,
    emitters: new Emitter({ source: EmissionShape.Sphere(0.01), rate: 0, bursts: [{ time: 0, count: 1 }],
      radialSpeed: 0, initialValues: { position: new THREE.Vector3(0, 0.4, 0), velocity: new THREE.Vector3(0, -2, 0),
        mass: 1, lifetime: 5, scale: 0.1 } }), modules: new Collision({ bounce: 0, dampen: 0 }),
    renderers: new MeshRenderer({ maxParticles: 8 }) });
  const child = new ParticleSystem({ gpuProcessing: true, maxParticles: 8, duration: 0.1, looping: false,
    gravityModifier: 0,
    emitters: new Emitter({ rate: 0, bursts: [{ time: 0, count: 1 }], radialSpeed: 0,
      initialValues: { mass: 3, lifetime: 5 } }),
    modules: [new MaterialCopy({ source: MaterialCopySource.Collision, sampleMode: MaterialCopySampleMode.UVPatch }),
      new Module(() => {}, { initializeParticle: p => { p.mass += 2; },
        initializeParticleGPU: (p, c) => {
          p.mass.addAssign(2);
          p.alpha.assign(c.event.materialCopy.x.greaterThan(0).select(1, 0));
        },
        modifyGPU() {} }),
      new Module(() => {}, { initializeParticle: p => { p.mass *= 2; },
        initializeParticleGPU: p => { p.mass.mulAssign(2); }, modifyGPU() {} })],
    renderers: new MeshRenderer({ maxParticles: 8 }),
  });
  parent.addSubSystem(child, { emitOnCollision: true, inheritMass: 0, inheritLifetime: 0 });
  scene.add(parent);
  try {
    renderer.render(scene, camera);
    parent.advanceFrames(30, 1 / 60);
    if (!parent.isGPUProcessingActive || !child.isGPUProcessingActive) {
      throw new Error('Native initialization fell back');
    }
    const snapshot = Array.from({ length: child._gpuBuffers.count }, () => new Particle());
    await child._gpuBuffers.readback(renderer, snapshot);
    const born = snapshot.filter(p => p.alive);
    if (!born.length || born.some(p => p.mass !== 10 || p.alpha !== 1 || p.materialCopy.x <= 0)) {
      throw new Error(`Native initialization was late or repeated: ${JSON.stringify(born.map(p => ({
        mass: p.mass, alpha: p.alpha, material: p.materialCopy.toArray(), u: p.materialCopyU.toArray(),
      })))}`);
    }
    return born.map(p => ({ mass: p.mass, binding: p.materialCopy.toArray() }));
  } finally {
    parent.destroy(); floor.geometry.dispose(); floorMaterial.dispose(); renderer.dispose();
  }
};

window.checkNativeCustomInitialization = async () => {
  const renderer = new WebGPURenderer();
  await renderer.init();
  renderer.setSize(16, 16);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 20);
  camera.position.z = 4;
  const material = new THREE.MeshStandardMaterial({ color: 'blue' });
  let id;
  const parent = new ParticleSystem({ gpuProcessing: true, maxParticles: 4, gravityModifier: 0,
    emitters: new Emitter({ rate: 0, bursts: [{ time: 0, count: 1 }],
      initialValues: { lifetime: 5, mass: 3 } }),
    modules: new Module(() => {}, {
      initializeParticleGPU: p => { p.mass.addAssign(2); },
      modifyGPU: p => {
        If(p.mass.equal(5), () => {
          p.emitEvent('paint', [vec4(id, 0.25, 0.75, 0)]);
          p.mass.assign(6);
        });
      },
    }), renderers: new MeshRenderer({ maxParticles: 4 }),
  });
  const child = new ParticleSystem({ gpuProcessing: true, maxParticles: 4, gravityModifier: 0,
    duration: 0.1, looping: false,
    emitters: new Emitter({ rate: 0, bursts: [{ time: 0, count: 1 }], initialValues: { lifetime: 5 } }),
    modules: [new MaterialCopy({ source: MaterialCopySource.Event,
      sampleMode: MaterialCopySampleMode.Color,
      resolveSourceGPU: (_p, context) => context.event ? { binding: context.event.data[0],
        u: vec3(1, 0, 0), v: vec3(0, 1, 0), point: vec3(100, 100, 0) } : undefined }),
    new Module(() => {}, { initializeParticleGPU: (p, context) => {
      p.mass.assign(context.event.data[0].x.add(context.source.mass));
    }, modifyGPU() {} })],
    renderers: new MeshRenderer({ maxParticles: 4 }),
  });
  parent.addSubSystem(child, { onEvent: ['paint'], inheritLifetime: 0 });
  id = parent.materialCopyRegistry.register(material);
  scene.add(parent);

  try {
    renderer.render(scene, camera);
    parent.advanceFrames(8, 1 / 60);
    if (!parent.isGPUProcessingActive || !child.isGPUProcessingActive) throw new Error('Custom event fell back');
    const snapshots = Array.from({ length: child._gpuBuffers.count }, () => new Particle());
    await child._gpuBuffers.readback(renderer, snapshots);
    const born = snapshots.filter(p => p.alive);
    if (born.length !== 1 || born[0].materialCopy.x !== id || born[0].materialCopy.y !== 0.25
      || born[0].materialCopy.z !== 0.75 || born[0].mass !== id + 5) throw new Error('Native custom event lost its immutable birth snapshot');
    return { material: born[0].materialCopy.toArray(), mass: born[0].mass };
  } finally {
    parent.destroy(); material.dispose(); renderer.dispose();
  }
};

window.checkManagedInitialization = async () => {
  const renderer = new WebGPURenderer();
  await renderer.init();
  renderer.setSize(16, 16);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 20);
  camera.position.z = 4;
  const material = new THREE.MeshStandardMaterial({ color: 'red' });
  const parent = new ParticleSystem({ gpuProcessing: true, maxParticles: 4, emitters: [], renderers: [] });
  parent.registerEmissionSource({ transform: new THREE.Matrix4(), metadata: { material } });
  const child = new ParticleSystem({ gpuProcessing: true, maxParticles: 4, gravityModifier: 0,
    emitters: new Emitter({ rate: 0, bursts: [{ time: 0, count: 1 }], initialValues: { lifetime: 5, mass: 3 } }),
    modules: [new MaterialCopy({ source: MaterialCopySource.Source }), new Module(() => {}, {
      initializeParticle: p => { p.mass *= 2; },
      initializeParticleGPU: p => { p.mass.mulAssign(2); }, modifyGPU() {},
    })], renderers: new MeshRenderer({ maxParticles: 4 }),
  });
  parent.addSubSystem(child, { emitContinuous: true, inheritLifetime: 0, inheritMass: 0 });
  scene.add(parent);

  try {
    renderer.render(scene, camera);
    parent.advanceFrames(8, 1 / 60);
    if (!child.isGPUProcessingActive) throw new Error('Managed-source simulation fell back');
    const snapshots = Array.from({ length: child._gpuBuffers.count }, () => new Particle());
    await child._gpuBuffers.readback(renderer, snapshots);
    const born = snapshots.filter(p => p.alive);
    if (born.length !== 1 || born[0].mass !== 6 || born[0].materialCopy.x <= 0) {
      throw new Error('Managed-source staged birth initialization was missing or repeated');
    }
    return { material: born[0].materialCopy.toArray(), mass: born[0].mass };
  } finally {
    parent.destroy(); material.dispose(); renderer.dispose();
  }
};

window.checkCompositeNormals = async (backend, unlit = false) => {
  const renderer = backend === 'webgpu' ? new WebGPURenderer() : new THREE.WebGLRenderer();
  if (backend === 'webgpu') await renderer.init();
  renderer.setSize(64, 64);
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, Math.PI));
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.set(3, 0, 4);
  camera.lookAt(0, 0, 0);
  const map = new THREE.DataTexture(new Uint8Array([204, 128, 230, 255]), 1, 1);
  map.needsUpdate = true;
  const source = new THREE.MeshStandardMaterial({ normalMap: map });
  const view = new MeshRenderer({ geometry: new THREE.PlaneGeometry(),
    material: unlit ? new THREE.MeshBasicMaterial() : new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 }),
    materialComposite: s => ({ color: `(${s.normal} * 0.5 + 0.5)` }),
    materialCompositeGPU: s => ({ color: s.normal.mul(0.5).add(0.5) }),
  });
  const system = new ParticleSystem({ emitters: [], renderers: view });
  scene.add(system);
  const particle = new Particle({ lifetime: 5 });
  particle.materialCopy.set(system.materialCopyRegistry.register(source), 0.5, 0.5, 2);
  const target = new THREE.WebGLRenderTarget(64, 64);

  try {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    view.update([particle], system);
    // Observe the channel directly, independently of the scene's illumination.
    const destination = view.instances.material;
    if (!unlit && backend === 'webgl') {
      const before = destination.onBeforeCompile;
      destination.onBeforeCompile = (shader, activeRenderer) => {
        before.call(destination, shader, activeRenderer);
        shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>',
          'outgoingLight = diffuseColor.rgb;\n#include <opaque_fragment>');
      };
      destination.customProgramCacheKey = () => 'normal-channel-observer';
      destination.needsUpdate = true;
    } else if (!unlit) {
      destination.emissiveNode = destination.colorNode;
      destination.colorNode = vec3(0);
      destination.needsUpdate = true;
    }
    if (backend === 'webgpu') await renderer.compileAsync(scene, camera);
    renderer.render(scene, camera);
    let pixels = new Uint8Array(64 * 64 * 4);
    if (backend === 'webgpu') pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 64, 64);
    else renderer.readRenderTargetPixels(target, 0, 0, 64, 64, pixels);
    const pixel = Array.from(pixels.slice((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 4));
    const normal = new THREE.Vector3(204 / 255 * 2 - 1, 128 / 255 * 2 - 1, 230 / 255 * 2 - 1)
      .normalize().transformDirection(camera.matrixWorldInverse);
    const expected = normal.toArray().map(v => (v * 0.5 + 0.5) * 255);
    if (pixel.slice(0, 3).some((v, i) => Math.abs(v - expected[i]) > 4)) {
      throw new Error(`${backend} view normals ${pixel}, expected ${expected}`);
    }
    return pixel;
  } finally {
    system.destroy(); map.dispose(); source.dispose(); target.dispose(); renderer.dispose();
  }
};

window.checkIntersectDecals = async backend => {
  const renderer = backend === 'webgpu' ? new WebGPURenderer() : new THREE.WebGLRenderer();
  if (backend === 'webgpu') await renderer.init();
  renderer.setSize(32, 32);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
  camera.position.z = 4;
  const wall = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 0.2),
    new THREE.MeshStandardMaterial({ color: 'red' }));
  scene.add(wall);
  const decals = new DecalRenderer(new THREE.MeshBasicMaterial(), {
    direction: DecalRenderer.Intersect(), continuousRate: 60, onSpawn: false,
    hitSelection: DecalRenderer.All, size: 0.2, depth: 0.04,
    inheritScale: 0, inheritColor: 0, lifetime: 10,
    materialComposite: s => ({ color: s.color }),
    materialCompositeGPU: s => ({ color: s.color }),
  });
  const system = new ParticleSystem({ gpuProcessing: backend === 'webgpu', maxParticles: 4,
    duration: 1, looping: false, gravityModifier: 0,
    emitters: new Emitter({ source: EmissionShape.Sphere(0.001), rate: 0, radialSpeed: 0,
      bursts: [{ time: 0, count: 1 }, { time: 0.4, count: 1 }, { time: 0.8, count: 1 }],
      initialValues: { position: new THREE.Vector3(0, 0, 1), velocity: new THREE.Vector3(0, 0, -10),
        lifetime: 0.25, scale: 0.1 } }), renderers: decals,
  });
  scene.add(system);
  try {
    renderer.render(scene, camera);
    for (let i = 0; i < 30; i++) {
      system.advanceFrames(4, 1 / 60);
      if (backend === 'webgpu') await renderer.backend.device.queue.onSubmittedWorkDone();
      await new Promise(resolve => setTimeout(resolve, 4));
    }
    if (backend === 'webgpu' && !system.isGPUProcessingActive) throw new Error('Intersection processing fell back');
    if (decals.count !== 6) throw new Error(`${backend} expected 6 entry/exit marks; got ${decals.count}`);
    if (decals.decals.some(decal => decal.appearanceParticle.materialCopy.x <= 0)) {
      throw new Error('An intersection decal lost its surface material binding');
    }
    return { count: decals.count, native: system.isGPUProcessingActive };
  } finally {
    system.destroy(); wall.geometry.dispose(); wall.material.dispose(); renderer.dispose();
  }
};

window.checkNormalDamageMask = async backend => {
  const renderer = backend === 'webgpu' ? new WebGPURenderer() : new THREE.WebGLRenderer();
  if (backend === 'webgpu') await renderer.init();
  renderer.setSize(96, 32);
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, Math.PI));
  const camera = new THREE.OrthographicCamera(-1, 1, 1 / 3, -1 / 3, 0.1, 10);
  camera.position.z = 4;
  const normalMap = new THREE.DataTexture(new Uint8Array([
    128, 128, 255, 255, 204, 128, 230, 255, 204, 128, 230, 255,
  ]), 3, 1);
  const roughnessMap = new THREE.DataTexture(new Uint8Array([
    255, 230, 255, 255, 255, 230, 255, 0, 255, 230, 255, 255,
  ]), 3, 1);
  for (const map of [normalMap, roughnessMap]) {
    map.minFilter = map.magFilter = THREE.NearestFilter;
    map.needsUpdate = true;
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(2, 1), new THREE.MeshBasicMaterial({ color: 'red' }));
  scene.add(floor);
  const material = new THREE.MeshStandardMaterial({ normalMap, roughnessMap });
  const view = new DecalRenderer(material, { direction: new THREE.Vector3(0, 0, -1),
    size: new THREE.Vector3(1.5, 0.5, 1), inheritScale: 0, inheritColor: 0,
    materialComposite: (_source, dest, context) => ({ color: 'vec3(1.0)',
      opacity: `${dest.opacity} * ${context.destMapAlpha}
        * smoothstep(0.01, 0.06, length(${dest.normal} - ${context.geometricNormal}))` }),
    materialCompositeGPU: (_source, dest, context) => ({ color: vec3(1),
      opacity: dest.opacity.mul(context.destMapAlpha)
        .mul(dest.normal.sub(context.geometricNormal).length().smoothstep(0.01, 0.06)) }),
  });
  const system = new ParticleSystem({ emitters: [], renderers: view });
  scene.add(system);
  const target = new THREE.WebGLRenderTarget(96, 32);
  try {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    view.update([], system, 0);
    system._notifySpawn(new Particle({ position: new THREE.Vector3(0, 0, 0.1) }));
    renderer.setRenderTarget(target);
    if (backend === 'webgpu') await renderer.compileAsync(scene, camera);
    renderer.render(scene, camera);
    let pixels = new Uint8Array(96 * 32 * 4);
    if (backend === 'webgpu') pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 96, 32);
    else renderer.readRenderTargetPixels(target, 0, 0, 96, 32, pixels);
    const samples = [24, 48, 72].map(x => Array.from(pixels.slice((16 * 96 + x) * 4, (16 * 96 + x) * 4 + 4)));
    if (samples[0][1] > 5 || samples[1][1] > 5 || samples[2][1] < 200) {
      throw new Error(`${backend}: flat normals/roughness alpha did not mask damage: ${JSON.stringify(samples)}`);
    }
    return samples;
  } finally {
    system.destroy(); floor.geometry.dispose(); floor.material.dispose(); material.dispose();
    normalMap.dispose(); roughnessMap.dispose(); target.dispose(); renderer.dispose();
  }
};

window.checkBulletSourceFiltering = async () => {
  const { default: createBullet } = await import('../../examples/dopplerBullet.js');
  const system = await createBullet();
  if (system.renderers.filter(view => view instanceof AudioRenderer).length !== 1) {
    throw new Error('The bullet must not duplicate audio playback and readbacks');
  }
  const surface = new THREE.MeshStandardMaterial({ color: 'red' });
  try {
    system.emitters[0].rate = 0;
    system.emitters[0].bursts = [];
    system.registerEmissionSource({ transform: new THREE.Matrix4(), tags: ['bullet-hole'], metadata: { material: surface } });
    system.advanceFrames(5, 0.02);
    const children = [...system.subSystems.keys()];
    if (children.some(child => child.name !== 'Bullet Impact Dust' && child.particles.length > 0)) {
      throw new Error('Hole registration retriggered bullet flash, shockwave, or continuous wakes');
    }
    const dust = children.find(child => child.name === 'Bullet Impact Dust');
    if (!dust || dust.particles.length < 5 || dust.particles.length > 8
      || dust.particles.some(p => p.materialCopy.w !== MaterialCopySampleMode.Color)) {
      throw new Error('Hole registration did not create a small fixed-color dust burst');
    }
    return { dust: dust.particles.length, otherEffects: children.filter(child => child !== dust)
      .map(child => child.particles.length) };
  } finally { system.destroy(); surface.dispose(); }
};

window.checkNativeRendererParameters = async () => {
  const renderer = new WebGPURenderer();
  await renderer.init();
  renderer.setSize(16, 16);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
  camera.position.set(0, 2, 4);
  camera.lookAt(0, 0, 0);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial());
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  let decalCalls = 0, audioCalls = 0;
  const cues = [];
  const decals = new DecalRenderer(new THREE.MeshBasicMaterial(), { onSpawn: false, size: 0.2,
    onEvent: { cue: (data, source, parameters) => {
      if (data[0].x !== 2 || !source.id.startsWith('gpu:')) throw new Error('Lost native decal event data');
      decalCalls++;
      return { size: parameters.size.clone().multiplyScalar(2), opacity: 0.25, lifetime: 3 };
    } },
  });
  const audio = new AudioRenderer({ onEvent: { cue: (data, _source, parameters) => {
    audioCalls++;
    return { sound: {}, pitch: data[0].x, volume: parameters.volume * 0.2 };
  } } });
  audio._ensureListener = () => {};
  audio._playOneShot = parameters => cues.push(parameters);
  const system = new ParticleSystem({ gpuProcessing: true, gravityModifier: 0, maxParticles: 4,
    emitters: new Emitter({ source: EmissionShape.Sphere(0.001), rate: 0, bursts: [{ time: 0, count: 1 }],
      radialSpeed: 0, initialValues: { position: new THREE.Vector3(0, 1, 0), mass: 1, lifetime: 3 } }),
    modules: new Module(() => {}, { modifyGPU: p => {
      If(p.mass.equal(1).and(p.realtime.greaterThan(50)), () => {
        p.emitEvent('cue', [vec4(2, 0, 0, 0)]);
        p.emitEvent('filtered', vec4(-1));
        p.emitEvent('blocked', vec4(1));
        p.emitEvent('filtered', vec4(2));
        p.mass.assign(2);
      });
    } }), renderers: [decals, audio],
  });
  const makeChild = () => new ParticleSystem({ gpuProcessing: true, maxParticles: 16, gravityModifier: 0,
    duration: 2, looping: false,
    emitters: new Emitter({ rate: 0, bursts: [{ time: 0, count: 1 }], initialValues: { lifetime: 5 } }),
    renderers: new MeshRenderer({ maxParticles: 16, material: new THREE.MeshBasicMaterial() }),
  });
  const filtered = makeChild(), unfiltered = makeChild();
  system.addSubSystem(filtered, { onEvent: { gpu: {
    filtered: data => data[0].x.greaterThan(0), blocked: () => false,
  } } });
  system.addSubSystem(unfiltered, { onEvent: ['filtered', 'blocked'] });
  scene.add(system);
  try {
    renderer.render(scene, camera);
    for (let i = 0; i < 20; i++) {
      system.advanceFrames(4, 1 / 60);
      await renderer.backend.device.queue.onSubmittedWorkDone();
      await new Promise(resolve => setTimeout(resolve, 4));
    }
    if (!system.isGPUProcessingActive || decalCalls !== 1 || audioCalls !== 1 || decals.count !== 1
      || cues.length !== 1 || cues[0].pitch !== 2 || Math.abs(cues[0].volume - 0.2) > 1e-6
      || decals.decals[0].mesh.material.opacity !== 0.25) {
      throw new Error(`Native renderer event parameters failed: ${JSON.stringify({
        native: system.isGPUProcessingActive, decalCalls, audioCalls, marks: decals.count, cues,
      })}`);
    }
    const counts = [];
    for (const child of [filtered, unfiltered]) {
      if (!child.isGPUProcessingActive) throw new Error('Event cancellation fell back to CPU');
      const snapshots = Array.from({ length: child._gpuBuffers.count }, () => new Particle());
      await child._gpuBuffers.readback(renderer, snapshots);
      counts.push(snapshots.filter(p => p.alive).length);
    }
    if (counts[0] !== 1 || counts[1] !== 3) {
      throw new Error(`Native cancellation counts: ${counts}`);
    }
    return { native: true, decalCalls, audioCalls, cancellationCounts: counts };
  } finally {
    system.destroy(); floor.geometry.dispose(); floor.material.dispose(); renderer.dispose();
  }
};

window.checkBulletDustVisibility = async backend => {
  const { default: createBullet } = await import('../../examples/dopplerBullet.js');
  const renderer = backend === 'webgpu' ? new WebGPURenderer() : new THREE.WebGLRenderer();
  if (backend === 'webgpu') await renderer.init();
  renderer.setSize(128, 128);
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, Math.PI));
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10);
  camera.position.set(0, 0, 2);
  const material = new THREE.MeshStandardMaterial({ color: '#dddddd' });
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), material);
  scene.add(surface);
  const system = await createBullet();
  system.useLiveCubemap = false;
  system.emitters[0].rate = 0;
  system.emitters[0].bursts = [];
  scene.add(system);
  if (backend === 'webgl') system.gpuProcessing = false;
  const dust = [...system.subSystems.keys()].find(child => child.name === 'Bullet Impact Dust');
  for (const child of system.subSystems.keys()) if (child !== dust) child.visible = false;
  const sampledMap = new THREE.DataTexture(new Uint8Array([0, 0, 255, 255]), 1, 1);
  sampledMap.needsUpdate = true;
  const sampled = new THREE.MeshStandardMaterial({ color: 'white', map: sampledMap });
  const target = new THREE.WebGLRenderTarget(128, 128);
  try {
    renderer.render(scene, camera);
    // Existing decal surfaces force the palette-texture path before the blue surface is sampled.
    system.materialCopyRegistry.register(material);
    system.materialCopyRegistry.register(surface.material.clone());
    const holes = system.renderers.find(view => view instanceof DecalRenderer);
    holes.onSpawn = true;
    holes.direction = new THREE.Vector3(0, 0, -1);
    surface.material = sampled;
    scene.updateMatrixWorld(true);
    system._notifySpawn(new Particle({ position: new THREE.Vector3(0, 0, 0.1), color: new THREE.Color('red') }));
    if (!holes.count) throw new Error('The dust color check failed to create its source decal');
    surface.material = material;
    for (let i = 0; i < 8; i++) {
      system.advanceFrames(1, 1 / 60);
      renderer.render(scene, camera);
      if (backend === 'webgpu') await renderer.backend.device.queue.onSubmittedWorkDone();
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    let particles = dust.particles;
    if (dust.isGPUProcessingActive) {
      particles = Array.from({ length: dust._gpuBuffers.count }, () => new Particle());
      await dust._gpuBuffers.readback(renderer, particles);
    }
    const live = particles.filter(particle => particle.alive);
    if (live.length < 5 || live.some(particle => particle.velocity.z < 0.39)) {
      throw new Error(`${backend} dust did not travel out along the surface normal`);
    }
    const read = async visible => {
      dust.visible = visible;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      if (backend === 'webgpu') return renderer.readRenderTargetPixelsAsync(target, 0, 0, 128, 128);
      const pixels = new Uint8Array(128 * 128 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 128, 128, pixels);
      return pixels;
    };
    const withDust = await read(true), withoutDust = await read(false);
    let changed = 0, redShift = 0;
    for (let i = 0; i < withDust.length; i += 4) {
      if (Math.max(...[0, 1, 2].map(channel => Math.abs(withDust[i + channel] - withoutDust[i + channel]))) > 5) {
        changed++;
        redShift += (withDust[i] - withoutDust[i]) - (withDust[i + 2] - withoutDust[i + 2]);
      }
    }
    if (changed < 30 || redShift > -100) throw new Error(`${backend} bullet dust affected only ${changed} pixels`);
    return { changed, redShift, bindings: live.slice(0, 2).map(particle => particle.materialCopy.toArray()) };
  } finally {
    renderer.setRenderTarget(null);
    system.destroy(); surface.geometry.dispose(); material.dispose(); sampled.dispose(); sampledMap.dispose();
    target.dispose(); renderer.dispose();
  }
};

window.checkCornellReflections = async (backend, initialBullet = false) => {
  const { default: createCornell } = await import('../../apps/demo/src/presets/scenes/cornellBox.js');
  const { createWebGPURenderer } = await import('../../apps/demo/src/rendering/createWebGPURenderer.js');
  const renderer = backend === 'webgpu' ? await createWebGPURenderer({}) : new THREE.WebGLRenderer();
  renderer.setSize(128, 128);
  renderer.shadowMap.enabled = true;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(1, 3, 7); camera.lookAt(-1.8, 1.1, -1.6);
  const handle = await createCornell(scene, renderer, camera);
  const { default: createDestruction } = await import('../../examples/destruction.js');
  const { getSceneParticleRoot } = await import('../../apps/demo/src/presets/scenes/particleRoot.js');
  const { default: createInitialBullet } = await import('../../examples/dopplerBullet.js');
  const system = await (initialBullet ? createInitialBullet() : createDestruction());
  if (initialBullet) system.renderers.find(view => view instanceof DecalRenderer).onCollision = true;
  if (backend === 'webgl') system.gpuProcessing = false;
  getSceneParticleRoot(scene).add(system);
  const glErrors = [];
  try {
    // Establish the display renderer before advancing native simulation.
    renderer.render(scene, camera);
    for (let i = 0; i < (backend === 'webgpu' ? 4 : 90); i++) {
      handle.update(1 / 24);
      system.advanceFrames(1, 1 / 24);
      renderer.render(scene, camera);
      if (backend === 'webgpu') await renderer.backend.device.queue.onSubmittedWorkDone();
      else {
        const error = renderer.getContext().getError();
        if (error) glErrors.push({ frame: i, error });
      }
    }
    let dustBindings;
    if (initialBullet && backend === 'webgl') {
      const dust = [...system.subSystems.keys()].find(child => child.name === 'Bullet Impact Dust');
      dustBindings = dust.particles.filter(particle => particle.alive).map(particle => ({
        binding: particle.materialCopy.toArray(),
        sourceColor: system.materialCopyRegistry.sources[particle.materialCopy.x]?.color?.getHexString(),
        particleColor: particle.color.getHexString(),
      }));
      if (!dustBindings.length || dustBindings.some(value => value.binding[0] <= 0)) {
        throw new Error(`Cornell bullet dust lost its sampled surface binding: ${JSON.stringify(dustBindings)}`);
      }
    }
    const metal = scene.children.flatMap(root => root.children).find(object => object.material?.metalness === 1);
    const pixel = new Uint8Array(4);
    if (backend === 'webgl') renderer.getContext().readPixels(64, 64, 1, 1,
      renderer.getContext().RGBA, renderer.getContext().UNSIGNED_BYTE, pixel);
    const point = metal.position.clone().add(new THREE.Vector3(0, 0, 1.1))
      .applyMatrix4(system.getSimulationToWorldMatrix().invert());
    const captureStart = performance.now();
    system.notifyCollision(new Particle({ position: point.clone() }), { object: metal, point,
      normal: new THREE.Vector3(0, 0, 1), impulse: new THREE.Vector3(0, 5, 0) });
    renderer.render(scene, camera);
    if (backend === 'webgpu') await renderer.backend.device.queue.onSubmittedWorkDone();

    const firstDecalMs = performance.now() - captureStart;
    const marks = system.renderers.find(view => view instanceof DecalRenderer).decals;
    const mark = marks.at(-1);
    if (glErrors.length || !mark || mark.mesh.material.envMap !== metal.material.envMap
      || mark.mesh.material.envMapIntensity !== metal.material.envMapIntensity) {
      throw new Error(`${backend}: Cornell environment: ${JSON.stringify({ glErrors,
        marks: marks.length, expected: metal.material.envMap?.uuid, got: mark?.mesh.material.envMap?.uuid,
        expectedIntensity: metal.material.envMapIntensity, gotIntensity: mark?.mesh.material.envMapIntensity,
        target: mark?.mesh.parent?.type, pixel: Array.from(pixel) })}`);
    }
    const cube = metal.children.find(object => object._renderTarget)?._renderTarget;
    if (!cube || cube.width < 16) throw new Error(`${backend} capture is below the PMREM minimum`);

    // A bright room face confirms the capture contains lighting, rather than only a valid texture object.
    if (backend === 'webgl') {
      const values = new Uint16Array(4);
      renderer.readRenderTargetPixels(cube, cube.width / 2, cube.height / 2, 1, 1, values, 2);
      if (!Array.from(values).slice(0, 3).some(value => THREE.DataUtils.fromHalfFloat(value) > 0.01)) {
        throw new Error('The WebGL environment capture contains no reflected room lighting');
      }
    }

    // Existing marks retain the borrowed texture as a later capture updates its pixels.
    const version = metal.material.envMap.pmremVersion;
    handle.update(1 / 24);
    renderer.render(scene, camera);
    if (backend === 'webgpu') await renderer.backend.device.queue.onSubmittedWorkDone();
    if (metal.material.envMap.pmremVersion <= version || mark.mesh.material.envMap !== metal.material.envMap) {
      throw new Error(`${backend} decal did not retain its live environment`);
    }

    // Exercise the same GUI replacement path as the demo, keeping the scene capture alive.
    const native = system.isGPUProcessingActive;
    const { ParticleSystemGUI } = await import('../../apps/demo/src/gui/ParticleSystemGUI.js');
    const { default: createBullet } = await import('../../examples/dopplerBullet.js');
    const { default: createFire } = await import('../../examples/fire.js');
    const gui = new ParticleSystemGUI({ system, scene, renderer, rendererMode: backend,
      presets: { Fire: createFire, Destruction: createDestruction, Bullet: createBullet } });
    let capturePixel;
    try {
      for (const [name, factory] of [['Fire', createFire], ['Bullet', createBullet],
        ['Destruction', createDestruction]]) {
        const replacement = await factory();
        gui.setSystem(replacement, name);
        for (let i = 0; i < 60; i++) {
          replacement.advanceFrames(1, 1 / 24);
          handle.update(1 / 24);
          renderer.render(scene, camera);
          if (backend === 'webgpu') await renderer.backend.device.queue.onSubmittedWorkDone();
        }
        if (backend === 'webgl') {
          const values = new Uint16Array(4);
          renderer.readRenderTargetPixels(cube, cube.width / 2, cube.height / 2, 1, 1, values, 2);
          capturePixel = Array.from(values).slice(0, 3).map(THREE.DataUtils.fromHalfFloat);
          if (!capturePixel.some(value => value > 0.01)) throw new Error(`${name} erased the live cubemap`);
          const error = renderer.getContext().getError();
          if (error) throw new Error(`${name} corrupted the live capture: ${error}`);
        }
      }
    } finally {
      gui.system.destroy(); gui.destroy();
    }
    return { envMap: true, copiedEnvMap: true, captureSize: cube.width, native, firstDecalMs, capturePixel, dustBindings };

  } finally {
    system.destroy(); handle.cleanup(); renderer.dispose();
  }
};

window.checkLateCopyTexture = async backend => {
  const renderer = backend === 'webgpu' ? new WebGPURenderer() : new THREE.WebGLRenderer();
  if (backend === 'webgpu') await renderer.init();
  renderer.setSize(16, 16);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  const source = new THREE.MeshBasicMaterial({ color: 'red' });
  const view = new MeshRenderer({ geometry: new THREE.PlaneGeometry(2, 2),
    material: new THREE.MeshBasicMaterial(), materialTarget: source, maxParticles: 1 });
  const system = new ParticleSystem({ emitters: [], renderers: view });
  scene.add(system);
  const particle = new Particle();
  const target = new THREE.WebGLRenderTarget(16, 16);
  const map = new THREE.DataTexture(new Uint8Array([0, 0, 255, 255]), 1, 1);
  map.needsUpdate = true;
  try {
    renderer.render(scene, camera);
    const read = async () => {
      view.update([particle], system, 0);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      if (backend === 'webgpu') return Array.from(await renderer.readRenderTargetPixelsAsync(target, 8, 8, 1, 1));
      const pixel = new Uint8Array(4);
      renderer.readRenderTargetPixels(target, 8, 8, 1, 1, pixel);
      return Array.from(pixel);
    };
    const solid = await read();
    source.color.set('white');
    source.map = map;
    source.needsUpdate = true;
    const textured = await read();
    if (solid[0] < 230 || solid[2] > 5 || textured[2] < 230 || textured[0] > 5) {
      throw new Error(`${backend} did not activate the late copy atlas: ${JSON.stringify({ solid, textured })}`);
    }
    return { solid, textured };
  } finally {
    renderer.setRenderTarget(null);
    system.destroy(); view.mesh.geometry.dispose(); source.dispose(); map.dispose();
    target.dispose(); renderer.dispose();
  }
};


window.checkDamageRoughnessMask = async backend => {
  const { default: createDestruction } = await import('../../examples/destruction.js');
  const { default: createBullet } = await import('../../examples/dopplerBullet.js');
  const renderer = backend === 'webgpu' ? new WebGPURenderer() : new THREE.WebGLRenderer();
  if (backend === 'webgpu') await renderer.init();
  renderer.setSize(96, 32);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, Math.PI));
  const camera = new THREE.OrthographicCamera(-1, 1, 1 / 3, -1 / 3, 0.1, 10);
  camera.position.z = 4;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(2, 1),
    new THREE.MeshStandardMaterial({ color: 'black', roughness: 0.1 }));
  scene.add(floor);
  const svg = content => 'data:image/svg+xml;base64,' + btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="3" height="1">${content}</svg>`);
  const roughness = svg('<path fill="rgb(204,204,204)" d="M0 0H3V1H0z"/>');
  const opacity = svg('<path fill="black" d="M0 0H1V1H0z"/>'
    + '<path fill="rgb(128,128,128)" d="M1 0H2V1H1z"/><path fill="white" d="M2 0H3V1H2z"/>');
  const albedo = svg('<path fill="white" fill-opacity="0.5" d="M1 0H2V1H1z"/>'
    + '<path fill="white" d="M2 0H3V1H2z"/>');
  const target = new THREE.WebGLRenderTarget(96, 32);
  const results = [];
  try {
    for (const kind of ['impact', 'bullet']) {
      const preset = await (kind === 'impact' ? createDestruction() : createBullet());
      const original = preset.renderers.find(view => view instanceof DecalRenderer);
      const template = [original.material].flat()[0].clone();
      const loader = new THREE.TextureLoader();
      template.map = kind === 'bullet' ? await loader.loadAsync(albedo) : null;
      template.alphaMap = kind === 'impact' ? await loader.loadAsync(opacity) : null;
      template.roughnessMap = await loader.loadAsync(roughness);
      template.normalMap = template.aoMap = null;
      const damage = { material: template, materialComposite: original.materialComposite,
        materialCompositeGPU: original.materialCompositeGPU, dispose() {
          template.map?.dispose(); template.alphaMap?.dispose(); template.roughnessMap.dispose();
          template.dispose(); preset.destroy();
        } };
      for (const map of [damage.material.map, damage.material.alphaMap, damage.material.roughnessMap]) {
        if (map) map.minFilter = map.magFilter = THREE.NearestFilter;
      }

      // Display the helper's roughness result as diffuse color so mask coverage is measurable.
      const view = new DecalRenderer(damage.material, { direction: new THREE.Vector3(0, 0, -1),
        size: new THREE.Vector3(1.5, 0.5, 1), inheritScale: 0, inheritColor: 0,
        materialComposite: (source, dest, context) => {
          const channels = damage.materialComposite(source, dest, context);
          return { ...channels, color: `vec3(${channels.roughness})` };
        },
        materialCompositeGPU: (source, dest, context) => {
          const channels = damage.materialCompositeGPU(source, dest, context);
          return { ...channels, color: vec3(channels.roughness) };
        },
      });
      const system = new ParticleSystem({ emitters: [], renderers: view });
      scene.add(system);
      try {
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        view.update([], system, 0);
        system._notifySpawn(new Particle({ position: new THREE.Vector3(0, 0, 0.1) }));
        if (backend === 'webgpu') await renderer.compileAsync(scene, camera);
        renderer.render(scene, camera);
        let pixels = new Uint8Array(96 * 32 * 4);
        if (backend === 'webgpu') pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 96, 32);
        else renderer.readRenderTargetPixels(target, 0, 0, 96, 32, pixels);
        const samples = [24, 48, 72].map(x => pixels[(16 * 96 + x) * 4]);
        if (samples[0] > 5 || samples[2] < (kind === 'impact' ? 15 : 150) || Math.abs(samples[1] / samples[2] - 0.5) > 0.08) {
          throw new Error(`${backend} ${kind}: roughness/alpha blend incorrect: ${samples}`);
        }
        results.push({ kind, samples });
      } finally {
        system.destroy(); scene.remove(system); damage.dispose();
      }
    }
    return results;
  } finally {
    floor.geometry.dispose(); floor.material.dispose(); target.dispose(); renderer.dispose();
  }
};


// Single-pixel stripes expose unwanted downsampling that broad color patches cannot detect.
window.checkAtlasDetail = async backend => {
  const renderer = backend === 'webgpu' ? new WebGPURenderer() : new THREE.WebGLRenderer();
  if (backend === 'webgpu') await renderer.init();
  const atlas = new TextureAtlas({ minCapacity: 4 });
  const size = 512;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      data.fill(x % 2 ? 255 : 0, offset, offset + 3);
      data[offset + 3] = 255;
    }
  }
  const stripes = new THREE.DataTexture(data, size, size);
  stripes.minFilter = stripes.magFilter = THREE.NearestFilter;
  stripes.needsUpdate = true;
  const larger = new THREE.DataTexture(new Uint8Array(1024 * 1024 * 4).fill(255), 1024, 1024);
  larger.needsUpdate = true;

  const read = async scale => {
    const rect = atlas.rect(0);
    const x = Math.round(rect.x * atlas.target.width);
    const y = Math.round(rect.y * atlas.target.height) + 16;
    const width = 16 * scale;
    const pixels = new Uint8Array(width * 4);
    if (backend === 'webgpu') {
      pixels.set(await renderer.readRenderTargetPixelsAsync(atlas.target, x, y, width, 1));
    } else renderer.readRenderTargetPixels(atlas.target, x, y, width, 1, pixels);
    const samples = Array.from({ length: 16 }, (_, index) => pixels[index * scale * 4]);
    if (samples.some((value, index) => Math.abs(value - (index % 2 ? 255 : 0)) > 2)) {
      throw new Error(`Atlas lost single-pixel detail: ${backend} ${JSON.stringify(samples)}`);
    }
    return samples;
  };

  try {
    atlas.add(stripes);
    atlas.update(renderer);
    if (atlas.tileSize !== size) throw new Error('Atlas did not preserve source resolution');
    const original = await read(1);
    atlas.add(larger);
    atlas.update(renderer);
    if (atlas.tileSize !== 1024) throw new Error('Atlas did not grow for a larger source');
    const grown = await read(2);
    return { original, grown, tileSize: atlas.tileSize };
  } finally {
    atlas.dispose(); stripes.dispose(); larger.dispose(); renderer.dispose();
  }
};

window.checkAtlasProgramReuse = () => {
  const renderer = new THREE.WebGLRenderer();
  renderer.setSize(32, 32);
  const atlas = new TextureAtlas({ tileSize: 16 });
  const textures = [16, 32, 64].map(size => {
    const data = new Uint8Array(size * size * 4).fill(255);
    const texture = new THREE.DataTexture(data, size, size);
    texture.needsUpdate = true;
    return texture;
  });
  const samples = [];
  try {
    for (const texture of textures) {
      const start = performance.now();
      atlas.add(texture);
      atlas.update(renderer);
      renderer.getContext().finish();
      samples.push({ size: texture.image.width, ms: performance.now() - start,
        capacity: atlas.grid.x * atlas.grid.y, programs: renderer.info.programs.length });
    }
    if (samples.some(sample => sample.programs !== 1)) {
      throw new Error(`Different image sizes compiled redundant atlas shaders: ${JSON.stringify(samples)}`);
    }
    return samples;
  } finally {
    atlas.dispose(); textures.forEach(texture => texture.dispose()); renderer.dispose();
  }
};

window.checkCubemapOwnerExclusion = backend => {
  const scene = new THREE.Scene();
  const owner = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  const capture = new LiveCubemap({ excludeParent: true });
  capture.setup(owner);
  scene.add(owner);
  let draws = 0;
  owner.onBeforeRender = () => { draws++; };
  return (async () => {
    const renderer = backend === 'webgpu' ? new WebGPURenderer() : new THREE.WebGLRenderer();
    if (backend === 'webgpu') await renderer.init();
    renderer.setSize(32, 32);
    try {
      scene.updateMatrixWorld(true);
      capture.update(scene, renderer, 1);
      if (draws || !owner.visible) throw new Error('Excluded cubemap owner was drawn or not restored');
      const cameraCount = capture.children.length;
      capture.dispose();
      if (capture.children.length !== cameraCount - 1) throw new Error('Disposed capture retained its cube camera');
      return { draws, visible: owner.visible };
    } finally {
      capture.dispose(); owner.geometry.dispose(); owner.material.dispose(); renderer.dispose();
    }
  })();
};


window.checkSpriteDisplayColor = () => {
  const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true });
  renderer.setSize(32, 32);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  const source = new THREE.MeshStandardMaterial({ color: '#cfc8b8' });
  const spriteTexture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  spriteTexture.needsUpdate = true;
  const results = [];
  try {
    for (const material of ['lit', 'unlit']) {
      const scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xffffff, 1));
      const view = new SpriteRenderer(spriteTexture, { material, materialTarget: source,
        materialComposite: source => ({ color: source.color }),
        materialOptions: material === 'lit' ? { roughness: 1, depthWrite: false } : { depthWrite: false } });
      const system = new ParticleSystem({ emitters: [], renderers: view, gpuProcessing: false });
      scene.add(system);
      try {
        renderer.render(scene, camera);
        const particle = new Particle({ lifetime: 10, color: new THREE.Color('#d7c091') });
        system.addParticle(particle);
        system.advanceFrames(1, 1 / 60);
        // Reproduce the missing conversion locally, without modifying the library or its shared build.
        const shader = view.material.fragmentShader;
        view.material.fragmentShader = shader.replace('#include <tonemapping_fragment>', '')
          .replace('#include <colorspace_fragment>', '');
        view.material.needsUpdate = true;
        renderer.render(scene, camera);
        const unconverted = new Uint8Array(4);
        const gl = renderer.getContext();
        gl.readPixels(16, 16, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, unconverted);

        // The corrected display must match the source cream despite the bronze particle tint.
        view.material.fragmentShader = shader;
        view.material.needsUpdate = true;
        renderer.render(scene, camera);
        const pixel = new Uint8Array(4);
        gl.readPixels(16, 16, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        results.push({ material, unconverted: Array.from(unconverted), pixel: Array.from(pixel) });
        if ([207, 200, 184, 255].some((value, index) => Math.abs(value - pixel[index]) > 2)) {
          throw new Error(`Copied cream displayed as bronze in ${material} sprites: ${JSON.stringify(results)}`);
        }

        // Framebuffer transmission already contains display-space RGB and must not be encoded again.
        scene.background = new THREE.Color('#8090a0');
        view.materialOptions = { ...view.materialOptions, transmission: 1, distortionStrength: 0 };
        system.advanceFrames(1, 1 / 60);
        renderer.render(scene, camera);
        const transmitted = new Uint8Array(4);
        gl.readPixels(16, 16, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, transmitted);
        results.at(-1).transmitted = Array.from(transmitted);
        if ([128, 144, 160, 255].some((value, index) => Math.abs(value - transmitted[index]) > 2)) {
          throw new Error(`Transmission was converted twice in ${material}: ${Array.from(transmitted)}`);
        }
      } finally {
        system.destroy();
      }
    }
    return results;
  } finally {
    source.dispose(); spriteTexture.dispose(); renderer.dispose();
  }
};
