import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { SpriteRenderer } from '../../build/index.mjs';

function rendererFixture() {
  let target = null;
  return {
    width: 64,
    height: 48,
    renders: 0,
    fail: false,
    getDrawingBufferSize(size) { return size.set(this.width, this.height); },
    getRenderTarget: () => target,
    setRenderTarget(value) { target = value; },
    clear() { if (this.fail) throw new Error('interrupted depth capture'); },
    render() { this.renders++; },
  };
}

for (const material of ['unlit', 'lit']) {
  test(`${material} soft depth owns its target and rebinds both CPU/GPU samplers across scenes and renderers`, () => {
    const sprite = new SpriteRenderer(new THREE.Texture(), { material, softParticleDistance: 0.5 });
    sprite.webgpuGPUMaterial = sprite.loadWebGPUMaterial(sprite.materialOptions);
    const renderer = rendererFixture();
    const camera = new THREE.PerspectiveCamera();
    const first = new THREE.Scene();
    const second = new THREE.Scene();
    const captures = [];
    function update(scene, activeRenderer = renderer) {
      sprite.updateWebGPUSoftParticles(activeRenderer, scene, camera);
      const data = scene.userData.__rzmps_webgpuSceneDepthData.get(activeRenderer);
      if (!captures.includes(data)) captures.push(data);
      assert.equal(data.target.depthTexture.renderTarget, data.target);
      for (const material of [sprite.webgpuMaterial, sprite.webgpuGPUMaterial])
        assert.equal(material.userData.sceneDepthNode.value, data.target.depthTexture);
      return data;
    }
    try {
      const a = update(first);
      const b = update(second);
      assert.notEqual(a.target.depthTexture, b.target.depthTexture);
      const otherRenderer = update(first, rendererFixture());
      assert.notEqual(otherRenderer.target.depthTexture, a.target.depthTexture);
      assert.equal(update(first), a);
      renderer.width = 96;
      assert.equal(update(first), a);
      assert.equal(a.target.width, 96);
      let disposed = 0;
      a.target.depthTexture.addEventListener('dispose', () => { disposed++; });
      sprite.destroy();
      assert.equal(disposed, 0, 'destroying one sprite must not dispose the shared scene depth');
    } finally {
      for (const data of captures) { data.target.dispose(); }
    }
  });
}

test('interrupted or minimized depth captures recover on the next update', () => {
  const sprite = new SpriteRenderer(new THREE.Texture(), { softParticleDistance: 0.5 });
  const renderer = rendererFixture();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  sprite.updateWebGPUSoftParticles(renderer, scene, camera);
  const data = scene.userData.__rzmps_webgpuSceneDepthData.get(renderer);
  const previous = new THREE.RenderTarget(8, 8);
  renderer.setRenderTarget(previous);
  const originalOverride = new THREE.MeshBasicMaterial();
  scene.overrideMaterial = originalOverride;
  try {
    renderer.fail = true;
    assert.throws(() => sprite.updateWebGPUSoftParticles(renderer, scene, camera), /interrupted/);
    assert.equal(data.rendering, false);
    assert.equal(scene.overrideMaterial, originalOverride);
    assert.equal(renderer.getRenderTarget(), previous);
    renderer.fail = false;
    renderer.width = renderer.height = 0;
    sprite.updateWebGPUSoftParticles(renderer, scene, camera);
    assert.equal(data.target.width, 1);
    assert.equal(data.target.height, 1);
    renderer.width = 64;
    renderer.height = 48;
    const before = renderer.renders;
    sprite.updateWebGPUSoftParticles(renderer, scene, camera);
    assert.equal(renderer.renders, before + 1);
    assert.equal(data.target.width, 64);
    assert.equal(data.rendering, false);
  } finally {
    sprite.destroy();
    data.target.dispose();
    previous.dispose();
    originalOverride.dispose();
  }
});
