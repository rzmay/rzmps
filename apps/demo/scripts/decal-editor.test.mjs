import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const demo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('decal editors and exports inspect configuration without walking the owning scene', { timeout: 20000 }, async () => {
  const server = await createServer({
    root: demo,
    configFile: path.join(demo, 'vite.config.mjs'),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
  });
  try {
    const { DecalRenderer, ParticleSystem } = await server.ssrLoadModule('@rzmps/rzmps');
    const THREE = await server.ssrLoadModule('three');
    for (const prefix of ['', 'particle-system-gui/']) {
      const { RendererGUI } = await server.ssrLoadModule(`/src/gui/${prefix}RendererGUI.js`);
      const { ParticleSystemSerializer } = await server.ssrLoadModule(`/src/gui/${prefix}ParticleSystemSerializer.js`);
      const map = new THREE.Texture({ src: '/splat2.png' });
      map.colorSpace = THREE.SRGBColorSpace;
      const normalMap = new THREE.Texture({ src: '/splat2_norm.jpg' });
      const renderer = new DecalRenderer(new THREE.MeshStandardMaterial({
        map, normalMap, normalScale: new THREE.Vector2(0.65, 0.65), roughness: 1,
      }), { maxHits: 3, continuousRate: 1.5, ratio: 0.5 });
      const system = new ParticleSystem({ emitters: [], renderers: [renderer] });
      const scene = new THREE.Scene();
      scene.add(system);
      // Generic traversal of renderer -> system -> parent reaches this sentinel.
      Object.defineProperty(scene, 'runtimeSentinel', { enumerable: true, get() { throw Error('Inspected live scene'); } });
      try {
        const inspected = [];
        const host = {
          prettyName: key => key,
          valueEditor: { addTags() {}, addValue(_folder, object, key) { inspected.push({ object, key }); } },
          emitterGUI: { buildUpdateLOD() {}, buildCountLOD() {} },
        };
        const folder = { addFolder() { return this; }, close() {}, add() { return { name() {} }; } };
        new RendererGUI(host).buildRenderer(folder, renderer, system);
        assert.ok(inspected.length > 0);
        assert.ok(inspected.every(({ object }) => object === renderer));
        assert.ok(inspected.some(({ key }) => key === 'continuousRate'));
        assert.equal('options' in renderer, false);
        const serializer = new ParticleSystemSerializer({ system });
        assert.throws(() => serializer.serializeValue(serializer.getSerializableRuntimeOptions(renderer)), /Inspected live scene/);
        const code = serializer.serializeParticleSystem();
        assert.ok(code.includes('new DecalRenderer(new THREE.MeshStandardMaterial('));
        assert.ok(code.includes('hitSelection: DecalRenderer.Nearest'));
        assert.ok(code.includes('maxHits: 3'));
        assert.ok(code.includes('continuousRate: 1.5'));
        assert.ok(code.length < 10000);
        assert.ok(!code.includes('runtimeSentinel'));
        assert.ok(!code.includes('raycaster:'));
        const exported = new Function('THREE', 'DecalRenderer', `return ${serializer.serializeRenderer(renderer)}`)({
          ...THREE,
          TextureLoader: class { load(src) { return new THREE.Texture({ src }); } },
        }, DecalRenderer);
        assert.equal(exported.continuousRate, 1.5);
        assert.equal(exported.ratio, 0.5);
        assert.equal(exported.material.map.image.src, '/splat2.png');
        assert.equal(exported.material.map.colorSpace, THREE.SRGBColorSpace);
        assert.equal(exported.material.normalMap.image.src, '/splat2_norm.jpg');
        assert.equal(exported.material.normalMap.colorSpace, THREE.NoColorSpace);
        assert.deepEqual(exported.material.normalScale.toArray(), [0.65, 0.65]);
        exported.destroy();
      } finally { system.destroy(); }
    }
  } finally { await server.close(); }
});
