import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';

test('surface attachment exports keep the shared renderer without traversing GPU resources', async () => {
  const demo = path.resolve(import.meta.dirname, '..');
  const server = await createServer({ root: demo, configFile: path.join(demo, 'vite.config.mjs'),
    server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  let system, surface, descriptor;
  try {
    const api = await server.ssrLoadModule('@rzmps/rzmps');
    const THREE = await server.ssrLoadModule('three');
    const { ParticleSystemSerializer } = await server.ssrLoadModule(
      '/src/gui/particle-system-gui/ParticleSystemSerializer.js');
    surface = new api.SurfaceRenderer();
    descriptor = Object.getOwnPropertyDescriptor(surface, 'surfaceQuery');
    Object.defineProperty(surface, 'surfaceQuery', { configurable: true, enumerable: true,
      get() { throw new Error('Traversed live GPU surface resources'); } });
    system = new api.ParticleSystem({ emitters: [], renderers: [surface] });
    const child = new api.ParticleSystem({ emitters: [], renderers: [], modules: [new api.SurfaceAttachment({
      surface, samplerGPU: surface.sampleSurfaceGPU, offset: 0.025, tangentialDrag: 3,
    })] });
    system.addSubSystem(child);
    const serializer = new ParticleSystemSerializer({ system });
    const code = serializer.serializeParticleSystem();
    assert(code.length < 20000, `Unexpectedly large code export: ${code.length}`);
    assert(!code.includes('surfaceQuery:'));
    assert.equal((code.match(/new SurfaceRenderer\(/g) ?? []).length, 1);
    assert.match(code, /samplerGPU: liquidSurface1\.sampleSurfaceGPU/);
    const names = code.match(/import \{ (.+) \} from '@rzmps\/rzmps'/)[1].split(', ');
    const body = code.replace(/^import .*;$/gm, '').replace('export default particleSystem;', 'return particleSystem;');
    const restored = Function('THREE', ...names, body)(THREE, ...names.map(name => api[name]));
    try {
      const attachment = [...restored.subSystems.keys()][0].getModules(api.SurfaceAttachment)[0];
      assert.equal(attachment.surface, restored.renderers[0]);
      assert.equal(attachment.samplerGPU, restored.renderers[0].sampleSurfaceGPU);
      assert.equal(attachment.offset, 0.025);
      assert.equal(attachment.tangentialDrag, 3);
      assert.match(serializer.serializeModule(attachment), /samplerGPU: surface\.sampleSurfaceGPU/);
    } finally { restored.destroy(); }
  } finally {
    if (descriptor) Object.defineProperty(surface, 'surfaceQuery', descriptor);
    system?.destroy();
    await server.close();
  }
});
