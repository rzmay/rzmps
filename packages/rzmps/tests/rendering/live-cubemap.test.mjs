import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { LiveCubemap, ParticleSystem, SpriteRenderer } from '../../build/index.mjs';

function fixture() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('navy');
  const previous = new THREE.WebGLRenderTarget(8, 8);
  let target = previous,
    face = 4,
    level = 2,
    clearAlpha = 0.25;
  const clearColor = new THREE.Color('green');
  const draws = [];
  const renderer = {
    coordinateSystem: THREE.WebGLCoordinateSystem,
    reversedDepthBuffer: false,
    autoClear: true,
    xr: { enabled: true },
    getSize: value => value.set(256, 192),
    getClearColor: value => value.copy(clearColor),
    getClearAlpha: () => clearAlpha,
    setClearColor(color, alpha) {
      clearColor.copy(color);
      clearAlpha = alpha;
    },
    getRenderTarget: () => target,
    getActiveCubeFace: () => face,
    getActiveMipmapLevel: () => level,
    setRenderTarget(value, nextFace = 0, nextLevel = 0) {
      target = value;
      face = nextFace;
      level = nextLevel;
    },
    render() {
      if (this.fail && face === 2) throw new Error('capture failed');
      const visible = [];
      scene.traverseVisible(object => {
        if (object.isMesh || object.isPoints) visible.push(object.name);
      });
      draws.push(visible);
    },
  };
  const live = new LiveCubemap();
  scene.add(live);
  function particle(name, material, visible = true) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), material);
    mesh.name = name;
    mesh.visible = visible;
    mesh.userData.__rzmps_particleRendererObject = true;
    scene.add(mesh);
    return mesh;
  }
  return {
    scene,
    renderer,
    live,
    particle,
    draws,
    previous,
    dispose() {
      live.dispose();
      previous.dispose();
    },
  };
}

test('capture includes particles without inspecting their materials unless explicitly excluded', () => {
  const f = fixture();
  const smoke = f.particle('smoke', new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4 }));
  const refractive = f.particle('physical', new THREE.MeshPhysicalMaterial({ transmission: 1 }));
  const shader = f.particle('shader', new THREE.ShaderMaterial({ uniforms: { transmission: { value: 1 } } }));
  const node = f.particle('node', new THREE.MeshBasicMaterial());
  node.material.transmissionNode = { isNode: true };
  const disabled = f.particle('disabled', new THREE.MeshBasicMaterial(), false);
  const sceneGlass = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshPhysicalMaterial({ transmission: 1 }));
  sceneGlass.name = 'scene glass';
  f.scene.add(sceneGlass);
  try {
    f.live.update(f.scene, f.renderer, 1);
    assert.equal(f.draws.length, 6);
    for (const draw of f.draws) assert.deepEqual(draw.sort(), ['node', 'physical', 'scene glass', 'shader', 'smoke']);
    assert.equal(smoke.visible, true);
    for (const mesh of [refractive, shader, node]) assert.equal(mesh.visible, true);
    assert.equal(disabled.visible, false);
    f.draws.length = 0;
    f.live.excludeParticleRenderers = true;
    f.live.update(f.scene, f.renderer, 1);
    for (const draw of f.draws) assert.deepEqual(draw, ['scene glass']);
  } finally {
    f.dispose();
  }
});

test('failed captures restore visibility, render target, XR, background and mipmap state', () => {
  const f = fixture();
  const effect = f.particle('distortion', new THREE.MeshBasicMaterial());
  const background = f.scene.background;
  f.renderer.fail = true;
  try {
    assert.throws(() => f.live.update(f.scene, f.renderer, 1), /capture failed/);
    assert.equal(effect.visible, true);
    assert.equal(f.renderer.getRenderTarget(), f.previous);
    assert.equal(f.renderer.getActiveCubeFace(), 4);
    assert.equal(f.renderer.getActiveMipmapLevel(), 2);
    assert.equal(f.renderer.xr.enabled, true);
    assert.equal(f.scene.background, background);
    assert.equal(f.renderer.getClearAlpha(), 0.25);
    assert.equal(f.renderer.getClearColor(new THREE.Color()).getHexString(), '008000');
    assert.equal(f.live.map.generateMipmaps, true);
  } finally {
    f.dispose();
  }
});

test('sprite transmission stays active for native capture cameras without changing visibility', () => {
  const sprite = new SpriteRenderer(new THREE.Texture(), { materialOptions: { transmission: 0.6 } });
  const system = new ParticleSystem({ emitters: [], modules: [], renderers: [sprite] });
  const main = new THREE.PerspectiveCamera();
  const cube = new THREE.CubeCamera(0.1, 100, new THREE.WebGLCubeRenderTarget(16));
  const scene = new THREE.Scene();
  system._camera = main;
  let copies = 0;
  const renderer = {
    info: { render: { frame: 0 } },
    getRenderTarget: () => null,
    getActiveCubeFace: () => 0,
    getCurrentViewport: value => value.set(0, 0, 256, 192),
    getDrawingBufferSize: value => value.set(256, 192),
    copyFramebufferToTexture: () => {
      copies++;
    },
  };
  const before = [sprite.points.visible, sprite.webglQuadMesh.visible, sprite.webgpuMesh.visible];
  try {
    for (const [camera, enabled, expectedCopies] of [
      [main, true, 1],
      [cube.children[0], true, 2],
      [cube.children[5], true, 3],
      [main, true, 4],
    ]) {
      renderer.info.render.frame++;
      sprite.prepareWebGLRender(renderer, scene, camera, system);
      for (const material of [sprite.material, sprite.quadMaterial]) {
        assert.equal(material.uniforms.useTransmission.value, enabled);
        assert.equal(material.uniforms.transmission.value, 0.6);
      }
      assert.equal(copies, expectedCopies);
      assert.deepEqual([sprite.points.visible, sprite.webglQuadMesh.visible, sprite.webgpuMesh.visible], before);
    }
  } finally {
    cube.renderTarget.dispose();
    system.destroy();
  }
});

test('a slow frame does not queue catch-up captures that exceed the configured frequency', () => {
  const f = fixture();
  f.live.fps = 2;
  try {
    f.live.update(f.scene, f.renderer, 10);
    assert.equal(f.draws.length, 6);
    f.live.update(f.scene, f.renderer, 0.1);
    assert.equal(f.draws.length, 6, 'missed captures must be dropped rather than replayed on the next frame');
    f.live.update(f.scene, f.renderer, 0.4);
    assert.equal(f.draws.length, 12);
  } finally {
    f.dispose();
  }
});


test('scene-color snapshots reuse separate probe and main textures instead of resizing between passes', () => {
  const sprite = new SpriteRenderer(new THREE.Texture(), { materialOptions: { transmission: 0.6 } });
  const scene = new THREE.Scene();
  const probe = new THREE.WebGLCubeRenderTarget(16);
  let target = null, face = 0, copies = 0, disposals = 0;
  const renderer = {
    info: { render: { frame: 0 } },
    getRenderTarget: () => target,
    getActiveCubeFace: () => face,
    getDrawingBufferSize: value => value.set(256, 192),
    copyFramebufferToTexture: () => { copies++; },
  };
  const main = sprite.getSceneColor(renderer, scene);
  main.addEventListener('dispose', () => { disposals++; });
  target = probe;
  const capture = sprite.getSceneColor(renderer, scene);
  capture.addEventListener('dispose', () => { disposals++; });
  assert.notEqual(capture, main);
  assert.equal(capture.image.width, 16);
  assert.equal(main.image.width, 256);
  assert.equal(sprite.getSceneColor(renderer, scene), capture);
  assert.equal(copies, 2);
  face = 5;
  assert.equal(sprite.getSceneColor(renderer, scene), capture);
  assert.equal(copies, 3);
  target = null;
  renderer.info.render.frame++;
  assert.equal(sprite.getSceneColor(renderer, scene), main);
  assert.equal(copies, 4);
  assert.equal(disposals, 0);
  probe.dispose();
  assert.equal(disposals, 1);
  main.dispose();
  sprite.destroy();
});


for (const fail of [false, true]) {
  test(`captures preserve shadow maps and pending update flags${fail ? ' when interrupted' : ''}`, () => {
    const f = fixture();
    const states = [[true, false], [true, true], [false, true], [false, false]];
    const lights = states.map(([autoUpdate, needsUpdate]) => {
      const light = new THREE.PointLight();
      light.castShadow = true;
      Object.assign(light.shadow, { autoUpdate, needsUpdate });
      f.scene.add(light);
      return light;
    });
    const render = f.renderer.render;
    let calls = 0;
    f.renderer.render = function (...args) {
      calls++;
      for (const light of lights) {
        assert.equal(light.shadow.autoUpdate, false);
        assert.equal(light.shadow.needsUpdate, false);
      }
      return render.apply(this, args);
    };
    f.renderer.fail = fail;
    try {
      if (fail) assert.throws(() => f.live.update(f.scene, f.renderer, 1), /capture failed/);
      else f.live.update(f.scene, f.renderer, 1);
      assert.equal(calls, fail ? 3 : 6);
      assert.deepEqual(lights.map(light => [light.shadow.autoUpdate, light.shadow.needsUpdate]), states);
    } finally {
      f.dispose();
    }
  });
}
