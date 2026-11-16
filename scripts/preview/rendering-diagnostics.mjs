import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { build, preview } from 'vite';
import puppeteer from 'puppeteer';
import { previewBrowserArguments } from './browserSettings.mjs';

// Serialize this function into a disposable browser entry: one retained diagnostic script.
async function browserDiagnostic() {
  const THREE = await import('three');
  const { WebGPURenderer } = await import('three/webgpu');
  const { viewportUV, screenSize, vec2, float } = await import('three/tsl');
  const { sceneColor, transmissionOutput, useTransmission } = await import('@rzmps/diagnostic-transmission');
  const { ParticleSystem, Particle, SpriteRenderer, LiveCubemap } = await import('@rzmps/rzmps');
  window.runDiagnostic = async (backend, mode, material) => {
    const previousTransmissionUpdate = useTransmission.update;
    if (mode === 'fallback') useTransmission.onRenderUpdate(() => 0);
    const renderer =
      backend === 'webgpu'
        ? new WebGPURenderer({ antialias: false })
        : new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    if (backend === 'webgpu') await renderer.init();
    renderer.setSize(256, 192);
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x112233, 1);
    document.body.replaceChildren(renderer.domElement);
    const scene = new THREE.Scene(),
      logs = [];
    scene.background = new THREE.Color(0x112233);
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    for (let x = -6; x <= 6; x += 0.25) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.25, 12, 0.1),
        new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL((x + 6) / 12, 0.8, 0.5) }),
      );
      mesh.position.set(x, 0, -4);
      scene.add(mesh);
    }
    const marker = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 0.4, 0.1),
      new THREE.MeshBasicMaterial({ color: 'yellow' }),
    );
    marker.position.set(0.9, 1.2, -3.8);
    scene.add(marker);
    const map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    const normal = new THREE.DataTexture(new Uint8Array([160, 128, 250, 255]), 1, 1);
    map.needsUpdate = normal.needsUpdate = true;
    const sprites = new SpriteRenderer(map, {
      billboard: false,
      material,
      materialOptions: {
        transmission: mode === 'plain' || mode === 'alphaReference' ? 0 : mode === 'fallback' ? 0.6 : 1,
        distortionMap: normal,
        distortionStrength: mode === 'normal' ? 0.2 : 0,
      },
      softParticleDistance: 0.3,
    });
    const system = new ParticleSystem({ emitters: [], modules: [], renderers: [sprites], gpuProcessing: false });
    const particle = new Particle({
      position: new THREE.Vector3(0, 0, -2),
      scale: new THREE.Vector3(1.4, 1.4, 1.4),
      color: new THREE.Color(0.2, 0.8, 0.3),
      alpha: mode === 'alphaReference' ? 0.7 * (1 - 0.6) : 0.7,
      lifetime: 10,
    });
    system.particles.push(particle);
    scene.add(system);
    const camera = new THREE.PerspectiveCamera(55, 256 / 192, 0.1, 100);
    camera.position.set(0, 0, 2);
    camera.lookAt(0, 0, -2);
    renderer.render(scene, camera);
    sprites.update([particle], system, 0);
    logs.push({
      event: 'particle-state',
      position: sprites.geometry.attributes.position?.array ? [...sprites.geometry.attributes.position.array] : null,
      scale: sprites.geometry.attributes.scale?.array ? [...sprites.geometry.attributes.scale.array] : null,
      color: sprites.geometry.attributes.color?.array ? [...sprites.geometry.attributes.color.array] : null,
      drawRange: sprites.geometry.drawRange,
      billboard: sprites.billboard,
      visible: sprites.points.visible,
      material: sprites.points.material.uuid,
      expectedMaterial: sprites.material.uuid,
    });
    if (mode === 'pixel' && backend === 'webgl') {
      for (const material of [sprites.material, sprites.quadMaterial]) {
        material.fragmentShader = material.fragmentShader.replace(
          /screenUv\s*\+\s*distortionUv/g,
          'screenUv + vec2(1.0, 0.0) / max(sceneColorResolution, vec2(1.0))',
        );
        if (!material.fragmentShader.includes('screenUv + vec2(1.0'))
          throw new Error('The one-pixel shader control did not match the active sprite shader');
        material.needsUpdate = true;
      }
    } else if (backend === 'webgpu' && (mode === 'pixel' || mode === 'sample')) {
      const coords = mode === 'pixel' ? viewportUV.add(vec2(1, 0).div(screenSize)) : viewportUV;
      sprites.webgpuMaterial.outputNode = transmissionOutput(
        sceneColor(coords),
        float(1),
        sprites.webgpuMaterial.opacityNode,
      );
      sprites.webgpuMaterial.needsUpdate = true;
    }
    if (backend === 'webgpu' && mode === 'fallback') {
      sprites.webgpuMaterial.outputNode = transmissionOutput(
        sceneColor(), float(0.6), sprites.webgpuMaterial.opacityNode,
      );
      sprites.webgpuMaterial.needsUpdate = true;
    }
    let capturing = false;
    let captureTextureCopies = 0;
    const copyTexture = renderer.copyTextureToTexture.bind(renderer);
    renderer.copyTextureToTexture = (...args) => {
      if (capturing) captureTextureCopies++;
      return copyTexture(...args);
    };
    if (backend === 'webgpu') {
      const copyFace = renderer.backend._copyFramebufferToTexture;
      renderer.backend._copyFramebufferToTexture = function (...args) {
        if (capturing)
          logs.push({ event: 'native-face-copy', face: renderer.getActiveCubeFace(), layer: args[5] ?? 0 });
        return copyFace.apply(this, args);
      };
    }
    const copy = renderer.copyFramebufferToTexture.bind(renderer);
    renderer.copyFramebufferToTexture = (texture, ...args) => {
      const target = renderer.getRenderTarget();
      logs.push({
        event: 'scene-color-copy',
        texture: texture.uuid,
        source: target ? [target.width, target.height] : [256, 192],
        destination: [texture.image?.width, texture.image?.height],
        feedback: target?.texture === texture,
        face: renderer.getActiveCubeFace(),
      });
      return copy(texture, ...args);
    };
    for (const object of [sprites.points, sprites.webglQuadMesh, sprites.webgpuMesh]) {
      const before = object.onBeforeRender;
      object.onBeforeRender = function (r, s, c, ...args) {
        before.call(this, r, s, c, ...args);
        if (mode === 'fallback' && backend === 'webgl')
          for (const material of [sprites.material, sprites.quadMaterial])
            material.uniforms.useTransmission.value = false;
        const target = r.getRenderTarget();
        logs.push({
          event: 'draw',
          camera: c.uuid,
          cubemap: LiveCubemap.isLiveCubemapCamera(c),
          face: r.getActiveCubeFace(),
          captureFace: c.parent?.children.indexOf(c),
          target: target ? [target.width, target.height] : [256, 192],
          transmission: sprites.material.uniforms?.transmission?.value,
          useTransmission: sprites.material.uniforms?.useTransmission?.value,
          sceneTexture: sprites.material.uniforms?.sceneColorTexture?.value?.uuid ?? null,
          uvNormalization:
            backend === 'webgl'
              ? sprites.material.uniforms.sceneColorResolution.value.toArray()
              : target
                ? [target.width, target.height]
                : [256, 192],
        });
      };
    }
    const live = new LiveCubemap({ resolutionScale: 0.25, fps: 1 });
    scene.add(live);
    scene.updateMatrixWorld(true);
    capturing = true;
    live.update(scene, renderer, 1);
    capturing = false;
    const cube = live._renderTarget;
    const imageChecks = [];
    async function image(target, width, height, faceIndex = 0) {
      const half = target.texture.type === THREE.HalfFloatType;
      const pixels =
        backend === 'webgpu'
          ? await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height, 0, faceIndex)
          : half
            ? new Uint16Array(width * height * 4)
            : new Uint8Array(width * height * 4);
      if (backend === 'webgl') renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels, faceIndex);
      const packed = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          for (let c = 0; c < 4; c++) {
            const from = (y * width + x) * 4 + c;
            const to = ((backend === 'webgl' ? height - y - 1 : y) * width + x) * 4 + c;
            packed[to] = half ? Math.round(255 * THREE.DataUtils.fromHalfFloat(pixels[from])) : pixels[from];
          }
      imageChecks.push(packed.reduce((hash, value) => Math.imul(hash ^ value, 16777619) >>> 0, 2166136261));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').putImageData(new ImageData(packed, width, height), 0, 0);
      return canvas.toDataURL();
    }
    const face = await image(cube, cube.width, cube.height, 5);
    let orientationMatches;
    if (backend === 'webgpu' && mode === 'plain') {
      // Ordinary particles must remain in the capture, matching a direct CubeCamera reference.
      live._cubeCamera.update(renderer, scene);
      await image(cube, cube.width, cube.height, 5);
      orientationMatches = imageChecks[0] === imageChecks[1];
    }
    // Compare all native cube faces against independent 2D renders with exactly the same cameras.
    const reference = backend === 'webgpu'
      ? new THREE.RenderTarget(cube.width, cube.height, { type: cube.texture.type })
      : new THREE.WebGLRenderTarget(cube.width, cube.height, { type: cube.texture.type });
    const faceReferences = [];
    for (let i = 0; i < 6; i++) {
      await image(cube, cube.width, cube.height, i);
      const actual = imageChecks.at(-1);
      renderer.setRenderTarget(reference);
      renderer.render(scene, live._cubeCamera.children[i]);
      renderer.setRenderTarget(null);
      await image(reference, cube.width, cube.height);
      faceReferences.push({ face: i, actual, expected: imageChecks.at(-1) });
    }
    reference.dispose();
    const reflector = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 16, 12),
      new THREE.MeshStandardMaterial({ envMap: live.map, metalness: 1, roughness: 0.15 }),
    );
    reflector.position.set(1.2, 0, -1);
    scene.add(reflector);
    const output = backend === 'webgpu' ? new THREE.RenderTarget(256, 192) : new THREE.WebGLRenderTarget(256, 192);
    renderer.setRenderTarget(output);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    const main = await image(output, 256, 192);
    const result = {
      backend,
      mode,
      face,
      main,
      logs,
      orientationMatches,
      faceReferences,
      faceChecksum: imageChecks[0],
      mainChecksum: imageChecks.at(-1),
      captureTextureCopies,
      capturePolicy: 'native-face-transmission',
      cubeFace: {
        index: 5,
        direction: '-Z',
        size: cube.width,
        cameraQuaternion: live._cubeCamera.children[5].quaternion.toArray(),
      },
    };
    live.dispose();
    output.dispose();
    system.destroy();
    renderer.dispose();
    useTransmission.update = previousTransmissionUpdate;
    return result;
  };
  window.checkCubemapShadow = async backend => {
    const renderer = backend === 'webgpu' ? new WebGPURenderer() : new THREE.WebGLRenderer();
    if (backend === 'webgpu') await renderer.init();
    renderer.setSize(128, 128);
    renderer.shadowMap.enabled = true;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('black');
    scene.add(new THREE.AmbientLight('white', 0.15));
    const light = new THREE.PointLight('white', 80);
    light.position.set(0, 5, 1);
    light.castShadow = true;
    light.shadow.mapSize.set(128, 128);
    scene.add(light);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.MeshStandardMaterial({ color: 'white' }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.7, 24, 16),
      new THREE.MeshStandardMaterial({ color: 'gray' }));
    sphere.position.set(0, 1, 0);
    sphere.castShadow = true;
    scene.add(sphere);
    const live = new LiveCubemap({ excludeParent: true, fps: 1, resolutionScale: 0.25 });
    live.setup(sphere);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 30);
    camera.position.set(3, 3, 5);
    camera.lookAt(0, 0.5, 0);
    const output = backend === 'webgpu' ? new THREE.RenderTarget(128, 128) : new THREE.WebGLRenderTarget(128, 128);
    const render = renderer.render.bind(renderer);
    let capturing = false, captureShadowPasses = 0;
    renderer.render = (s, c) => {
      if (capturing && c === light.shadow.camera) captureShadowPasses++;
      return render(s, c);
    };
    async function sample() {
      renderer.setRenderTarget(output);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      const pixels = backend === 'webgpu'
        ? await renderer.readRenderTargetPixelsAsync(output, 0, 0, 128, 128) : new Uint8Array(128 * 128 * 4);
      if (backend === 'webgl') renderer.readRenderTargetPixels(output, 0, 0, 128, 128, pixels);
      return pixels.reduce((hash, value) => Math.imul(hash ^ value, 16777619) >>> 0, 2166136261);
    }
    const checksums = [await sample()];
    for (let i = 0; i < 3; i++) {
      // Manual render() calls do not advance WebGPU's animation-frame cache; reproduce the real frame boundary.
      if (backend === 'webgpu') renderer._nodes.nodeFrame.update();
      // A soft-particle depth prepass has already rendered with the main camera in the same frame.
      checksums.push(await sample());
      capturing = true;
      live.update(scene, renderer, 1);
      capturing = false;
      checksums.push(await sample());
    }
    live.dispose();
    output.dispose();
    renderer.dispose();
    return {
      checksums, captureShadowPasses, autoUpdate: light.shadow.autoUpdate, needsUpdate: light.shadow.needsUpdate,
    };
  };
  window.checkSoftDepth = async () => {
    const renderer = new WebGPURenderer({ antialias: false });
    await renderer.init();
    renderer.setSize(64, 64);
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 20);
    camera.position.z = 2;
    const map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    map.needsUpdate = true;
    const fixtures = [];
    function create() {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color('black');
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicMaterial({ color: 'black' }));
      wall.position.z = -2.02;
      scene.add(wall);
      const sprite = new SpriteRenderer(map, { billboard: false, softParticleDistance: 0.5 });
      const system = new ParticleSystem({ emitters: [], modules: [], renderers: [sprite], gpuProcessing: false });
      scene.add(system);
      const particle = new Particle({ position: new THREE.Vector3(0, 0, -2), scale: new THREE.Vector3(2, 2, 2),
        color: new THREE.Color('red'), lifetime: 10 });
      renderer.render(scene, camera);
      sprite.update([particle], system, 0);
      const data = scene.userData.__rzmps_webgpuSceneDepthData.get(renderer);
      const fixture = { scene, sprite, system, data, particle, wall };
      fixtures.push(fixture);
      return fixture;
    }
    const samples = [];
    async function sample(fixture, stage) {
      fixture.sprite.update([fixture.particle], fixture.system, 0);
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      const output = new THREE.RenderTarget(size.x, size.y);
      renderer.setRenderTarget(output);
      renderer.render(fixture.scene, camera);
      renderer.setRenderTarget(null);
      const pixel = await renderer.readRenderTargetPixelsAsync(
        output, Math.floor(size.x / 2), Math.floor(size.y / 2), 1, 1,
      );
      output.dispose();
      const depth = fixture.data.target.depthTexture;
      samples.push({ stage, pixel: [...pixel], ownsDepth: depth.renderTarget === fixture.data.target,
        samplerMatches: fixture.sprite.webgpuMaterial.userData.sceneDepthNode.value === depth,
        targetSize: [fixture.data.target.width, fixture.data.target.height],
        textureSize: [depth.image.width, depth.image.height], texture: depth.uuid });
    }
    const first = create();
    await sample(first, 'initial');
    const second = create();
    await sample(second, 'second-scene');
    renderer.setSize(96, 64);
    await sample(second, 'resized');
    renderer.setSize(64, 64);
    await sample(first, 'returned');
    window.resumeSoftDepth = async () => {
      await sample(first, 'tab-return');
      first.wall.position.z = -4;
      await sample(first, 'moved-away');
      first.wall.position.z = -2.02;
      await sample(first, 'moved-back');
      first.data.target.dispose();
      await sample(first, 'disposed-and-reacquired');
      const clear = renderer.clear;
      renderer.clear = () => { throw new Error('interrupted depth prepass'); };
      try { first.sprite.update([first.particle], first.system, 0); } catch { /* exercise recovery */ }
      finally { renderer.clear = clear; }
      await sample(first, 'after-interrupted-prepass');
      for (const fixture of fixtures) { fixture.system.destroy(); fixture.data.target.dispose(); }
      map.dispose();
      renderer.dispose();
      return samples;
    };
    return samples;
  };
  window.checkRendering = async backend => {
    const { DecalRenderer, MeshRenderer, createGPUParticleBufferState } = await import('@rzmps/rzmps');
    const renderer =
      backend === 'webgpu' ? new WebGPURenderer() : new THREE.WebGLRenderer({ preserveDrawingBuffer: true });
    if (backend === 'webgpu') await renderer.init();
    renderer.setSize(256, 192);
    renderer.setPixelRatio(1);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 256 / 192, 0.1, 100);
    const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    texture.needsUpdate = true;
    const sprites = new SpriteRenderer(texture, { billboard: false });
    const decals = new DecalRenderer(new THREE.MeshBasicMaterial({ color: 'red' }), {
      direction: new THREE.Vector3(0, 0, -1),
      size: 2,
      maxDistance: 2,
      inheritColor: 0,
      inheritScale: 0,
      inheritAlpha: 0,
    });
    const owner = new ParticleSystem({
      emitters: [],
      modules: [],
      renderers: [sprites, decals],
      simulationSpace: 'local',
      gpuProcessing: false,
    });
    owner.position.z = -10;
    const particle = new Particle({
      position: new THREE.Vector3(0, 0, 9),
      scale: new THREE.Vector3(2, 2, 2),
      color: new THREE.Color('lime'),
      lifetime: 10,
    });
    const rear = new Particle({ position: new THREE.Vector3(0, 0, -9), lifetime: 10 });
    const batch = [particle, rear];
    owner.particles.push(...batch);
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial({ color: 'gray' }));
    wall.position.z = -2;
    scene.add(owner, wall);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, -1.5);
    renderer.render(scene, camera);
    sprites.update(batch, owner, 0);
    owner._notifySpawn(particle);
    const decal = decals.decals[0]?.mesh;
    if (!decal) throw new Error('The ordering diagnostic failed to create its surface decal');
    const correctedOrder = decal.renderOrder;
    if (!(correctedOrder < 0)) throw new Error('Decals must composite before the default particle render order');
    const draws = [],
      captures = [];
    for (const object of [sprites.webglQuadMesh, sprites.webgpuMesh, decal]) {
      const before = object.onBeforeRender;
      object.onBeforeRender = function (...args) {
        before.apply(this, args);
        draws.push(object === decal ? 'decal' : 'particle');
      };
    }
    const target = backend === 'webgpu' ? new THREE.RenderTarget(256, 192) : new THREE.WebGLRenderTarget(256, 192);
    for (const order of [0, correctedOrder])
      for (const x of [-3, 0, 3]) {
        camera.position.set(x, 0, 5);
        camera.lookAt(0, 0, -1.5);
        decal.renderOrder = order;
        draws.length = 0;
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        const pixels =
          backend === 'webgpu'
            ? await renderer.readRenderTargetPixelsAsync(target, 0, 0, 256, 192)
            : new Uint8Array(256 * 192 * 4);
        if (backend === 'webgl') renderer.readRenderTargetPixels(target, 0, 0, 256, 192, pixels);
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 192;
        canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), 256, 192), 0, 0);
        const center = [...pixels.slice((96 * 256 + 128) * 4, (96 * 256 + 128) * 4 + 4)];
        captures.push({ order, cameraX: x, draws: [...draws], center, png: canvas.toDataURL() });
        if (order < 0 && !(center[1] > center[0])) throw new Error('A foreground particle was occluded by its decal');
      }
    if (!captures.some(capture => capture.order === 0 && capture.center[0] > capture.center[1]))
      throw new Error('Legacy particle-batch sorting was not reproduced by the ordering control');
    decal.renderOrder = correctedOrder;
    particle.position.z = 7;
    sprites.update(batch, owner, 0);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, -1.5);
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    const behind =
      backend === 'webgpu' ? await renderer.readRenderTargetPixelsAsync(target, 128, 96, 1, 1) : new Uint8Array(4);
    if (backend === 'webgl') renderer.readRenderTargetPixels(target, 128, 96, 1, 1, behind);
    if (!(behind[0] > behind[1])) throw new Error('Opaque surface failed to occlude a particle behind it');
    owner.destroy();
    wall.removeFromParent();
    wall.geometry.dispose();
    wall.material.dispose();
    target.dispose();
    const rotations = [];
    if (backend === 'webgpu') {
      const parent = new Particle({ rotation: new THREE.Vector3(0.4, -0.5, 0.7), lifetime: 10 });
      parent.time = 0.3;
      const inherited = new THREE.Quaternion().setFromEuler(new THREE.Euler().setFromVector3(parent.rotation));
      for (const rotation of [
        0,
        0.25,
        new THREE.Vector3(-0.2, 0.6, 0.1),
        t => new THREE.Vector3(t, 0, -t),
        [-0.4, 0.4],
        new Set([0.1, 0.2]),
      ]) {
        const mesh = new MeshRenderer({ maxParticles: 4, children: { count: 1, rotation } });
        const system = new ParticleSystem({ emitters: [], modules: [], renderers: [mesh], gpuProcessing: false });
        system._renderer = renderer;
        system._camera = camera;
        const input = createGPUParticleBufferState([parent], 1);
        input.initialize(renderer);
        mesh.updateGPU(input, system, 0);
        const output = mesh._gpuChildren.output;
        const read = async () => {
          const data = new Float32Array(await renderer.getArrayBufferAsync(output.attributes.floatData));
          // Render arena ABI: first child follows one original; rotation is the second vec4 slot.
          return new THREE.Vector3().fromArray(data, output.floatStride + 4);
        };
        const actual = await read();
        scene.add(system);
        const meshTarget = new THREE.RenderTarget(32, 32);
        renderer.setRenderTarget(meshTarget);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        meshTarget.dispose();
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler().setFromVector3(actual));
        const offset =
          typeof rotation === 'function'
            ? rotation(parent.time)
            : typeof rotation === 'number'
              ? new THREE.Vector3().setScalar(rotation)
              : rotation;
        if (!Array.isArray(rotation) && !(rotation instanceof Set)) {
          const expected = inherited
            .clone()
            .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler().setFromVector3(offset)));
          if (q.angleTo(expected) > 1e-3)
            throw new Error('GPU child orientation differs from CPU quaternion composition');
        } else {
          mesh.updateGPU(input, system, 0);
          if (actual.distanceTo(await read()) > 1e-6)
            throw new Error('GPU random rotation changed with the same identity');
          const local = new THREE.Euler().setFromQuaternion(inherited.clone().invert().multiply(q));
          if (Array.isArray(rotation) && [local.x, local.y, local.z].some(value => value < -0.401 || value > 0.401))
            throw new Error('Random child rotation escaped the configured range');
        }
        rotations.push({ kind: typeof rotation, euler: actual.toArray() });
        input.dispose(renderer);
        system.destroy();
      }
    }
    renderer.dispose();
    return { captures, rotations, behind: [...behind.slice(0, 4)] };
  };
}

const { values } = parseArgs({
  options: {
    backend: { type: 'string', default: 'webgl' },
    material: { type: 'string', default: 'unlit' },
    output: { type: 'string', default: 'benchmark-results/rendering-diagnostics' },
    check: { type: 'boolean', default: false },
    'soft-depth': { type: 'boolean', default: false },
    shadow: { type: 'boolean', default: false },
  },
});
if (!['lit', 'unlit'].includes(values.material)) throw new Error('Use --material lit or unlit');
if (!['webgl', 'webgpu'].includes(values.backend)) throw new Error('Use --backend webgl or webgpu');
const root = path.resolve(import.meta.dirname, '../..'),
  output = path.resolve(values.output);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rzmps-rendering-diagnostic-'));
let browser, server;
const report = { backend: values.backend, material: values.material, results: [], browserErrors: [] };
try {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(
    path.join(temporary, 'index.html'),
    '<link rel="icon" href="data:,"><script type="module" src="/entry.js"></script>',
  );
  await fs.writeFile(path.join(temporary, 'entry.js'), `(${browserDiagnostic.toString()})();`);
  await build({
    root: temporary,
    configFile: false,
    logLevel: 'error',
    resolve: {
      alias: [
        { find: '@rzmps/rzmps', replacement: path.join(root, 'packages/rzmps/build/index.mjs') },
        {
          find: '@rzmps/diagnostic-transmission',
          replacement: path.join(root, 'packages/rzmps/src/rendering/materials/transmission.utils.ts'),
        },
        ...['', '/webgpu', '/tsl'].map((suffix, i) => ({
          find: new RegExp('^three' + suffix + '$'),
          replacement: path.join(
            root,
            'node_modules/three/build',
            ['three.module.js', 'three.webgpu.js', 'three.tsl.js'][i],
          ),
        })),
      ],
    },
  });
  server = await preview({ root: temporary, configFile: false, preview: { host: '127.0.0.1', port: 0 } });
  browser = await puppeteer.launch({
    headless: true,
    args: previewBrowserArguments(),
    timeout: 10000,
    protocolTimeout: 20000,
    defaultViewport: { width: 256, height: 192 },
  });
  const page = await browser.newPage();
  page.on('pageerror', error => report.browserErrors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error') report.browserErrors.push(message.text());
  });
  const address = server.httpServer.address();
  if (values.shadow) {
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction(() => typeof window.checkCubemapShadow === 'function', { timeout: 10000 });
    report.shadow = await page.evaluate(backend => window.checkCubemapShadow(backend), values.backend);
    console.log(JSON.stringify(report.shadow, null, 2));
    if (values.check && (report.shadow.checksums.some(hash => hash !== report.shadow.checksums[0])
      || report.shadow.captureShadowPasses !== 0)) throw new Error('Live cubemap capture changed the main-view shadow');
  }
  if (values['soft-depth']) {
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction(() => typeof window.checkSoftDepth === 'function', { timeout: 10000 });
    await page.evaluate(() => window.checkSoftDepth());
    const otherTab = await browser.newPage();
    await otherTab.bringToFront();
    report.backgroundVisibility = await page.evaluate(() => document.visibilityState);
    const lifecycle = await page.createCDPSession();
    await lifecycle.send('Page.setWebLifecycleState', { state: 'frozen' });
    await lifecycle.send('Page.setWebLifecycleState', { state: 'active' });
    await page.bringToFront();
    report.softDepth = await page.evaluate(() => window.resumeSoftDepth());
    await otherTab.close();
    if (values.check) {
      for (const sample of report.softDepth) {
        if (!sample.ownsDepth || !sample.samplerMatches
          || sample.targetSize.some((size, i) => size !== sample.textureSize[i]))
          throw new Error(`${sample.stage}: stale depth texture ownership, dimensions or sampler binding`);
        const red = sample.pixel[0];
        if (sample.stage === 'moved-away' ? red < 240 : red > 5)
          throw new Error(`${sample.stage}: soft particles did not track the scene depth (${red})`);
      }
      report.checked = true;
    }
    console.log(JSON.stringify(report.softDepth, null, 2));
  }
  const modes = values['soft-depth'] || values.shadow
    ? [] : ['normal', 'sample', 'pixel', 'plain', 'fallback', 'alphaReference'];
  for (const mode of modes) {
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction(() => typeof window.runDiagnostic === 'function', { timeout: 10000 });
    const result = await page.evaluate(
      (backend, mode, material) => window.runDiagnostic(backend, mode, material),
      values.backend,
      mode,
      values.material,
    );
    for (const kind of ['face', 'main']) {
      await fs.writeFile(path.join(output, `${mode}-${kind}.png`), Buffer.from(result[kind].split(',')[1], 'base64'));
      delete result[kind];
    }
    report.results.push(result);
    console.log(`${values.backend}: ${mode} captured; ${result.logs.length} draw/copy records`);
  }
  if (values.check && !values['soft-depth'] && !values.shadow) {
    const checks = await page.evaluate(backend => window.checkRendering(backend), values.backend);
    for (const [i, capture] of checks.captures.entries()) {
      await fs.writeFile(path.join(output, `decal-order-${i}.png`), Buffer.from(capture.png.split(',')[1], 'base64'));
      delete capture.png;
    }
    report.checks = checks;
    const controls = report.results.map(result => result.faceChecksum);
    if (controls[0] === controls[1] || controls[1] === controls[2])
      throw new Error('Cubemap transmission/distortion controls are indistinguishable');
    const fallback = report.results.find(result => result.mode === 'fallback');
    const alphaReference = report.results.find(result => result.mode === 'alphaReference');
    if (fallback.faceChecksum !== alphaReference.faceChecksum || fallback.mainChecksum !== alphaReference.mainChecksum)
      throw new Error('Transmission fallback differs from opacity * (1 - transmission) alpha blending');
    const mainControls = report.results.map(result => result.mainChecksum);
    if (mainControls[0] === mainControls[1] || mainControls[1] === mainControls[2])
      throw new Error('Main-camera transmission/distortion controls are indistinguishable');
    for (const result of report.results) {
      if (result.faceReferences.some(face => face.actual !== face.expected))
        throw new Error(`${result.mode}: native cube pixels differ from independent face-camera renders`);
      if (result.logs.some(entry => entry.event === 'native-face-copy' && entry.face !== entry.layer))
        throw new Error('Framebuffer copy sampled the wrong cube face');
      if (result.captureTextureCopies !== 0) throw new Error('Cubemap face staging copies remain active');
      const draws = result.logs.filter(entry => entry.event === 'draw' && entry.cubemap);
      if (draws.length === 0) throw new Error('Capture hid particles instead of disabling transmission');
    }
    if (values.backend === 'webgpu' && !report.results.find(result => result.mode === 'plain').orientationMatches)
      throw new Error('Capture changed the CubeCamera reference orientation');
    report.checked = true;
  }
  if (report.browserErrors.length) throw new Error(report.browserErrors.join('\n'));
  console.log(`Diagnostic images and report: ${output}`);
} catch (error) {
  report.failure = String(error);
  throw error;
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  await server?.httpServer.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
