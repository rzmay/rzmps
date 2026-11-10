import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { previewBrowserArguments } from '../../preview/browserSettings.mjs';
import { packRGBA } from '../../preview/readback.utils.mjs';
import { installWebGPUDiagnostics } from '../../preview/webgpuDiagnostics.mjs';
import { attachBrowserDiagnostics } from '../../preview/browserDiagnostics.mjs';

test('software flags are limited to Linux CI; native previews keep their graphics backend', () => {
  const linux = previewBrowserArguments({ platform: 'linux', ci: true });
  assert.ok(linux.includes('--use-webgpu-adapter=swiftshader'));
  assert.ok(linux.includes('--disable-gpu-watchdog'));
  assert.ok(linux.includes('--js-flags=--no-maglev'));
  assert.ok(!linux.includes('--disable-gpu'));
  for (const platform of ['darwin', 'win32']) {
    const native = previewBrowserArguments({ platform, ci: true });
    assert.ok(!native.includes('--use-webgpu-adapter=swiftshader'));
    assert.ok(!native.includes('--disable-gpu-watchdog'));
    assert.ok(!native.includes('--js-flags=--no-maglev'));
  }
});

test('RGBA readback removes padded rows and rejects incomplete output', () => {
  const padded = new Uint8Array(264);
  padded.set([1, 2, 3, 4, 5, 6, 7, 8]);
  padded.set([9, 10, 11, 12, 13, 14, 15, 16], 256);
  assert.deepEqual(
    [...packRGBA(padded, 2, 2)],
    Array.from({ length: 16 }, (_, i) => i + 1),
  );
  assert.deepEqual([...packRGBA(new Uint8Array([1, 2, 3, 4]), 1, 1)], [1, 2, 3, 4]);
  assert.throws(() => packRGBA(new Uint8Array(12), 2, 2), /Incomplete/);
});

test('WebGPU instrumentation records failures and pipeline timing without replacing results', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const events = [];
  const callbacks = new Map();
  let lost;
  const pipeline = {};
  const device = {
    features: new Set(['core-features-and-limits']),
    limits: Object.create({ maxBindGroups: 4 }),
    lost: new Promise(resolve => {
      lost = resolve;
    }),
    addEventListener: (name, callback) => callbacks.set(name, callback),
    createShaderModule: () => ({
      getCompilationInfo: async () => ({ messages: [{ type: 'error', message: 'bad shader', lineNum: 3 }] }),
    }),
    createRenderPipeline: () => pipeline,
    createComputePipeline: () => pipeline,
    createRenderPipelineAsync: async () => pipeline,
    createComputePipelineAsync: async () => pipeline,
  };
  const adapter = {
    features: new Set(),
    limits: Object.create({ maxBindGroups: 4 }),
    info: { vendor: 'test' },
    requestDevice: async () => device,
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { gpu: { requestAdapter: async () => adapter } },
  });
  globalThis.rzmpsPreviewReport = event => events.push(event);
  try {
    installWebGPUDiagnostics();
    const selected = await navigator.gpu.requestAdapter({ featureLevel: 'compatibility' });
    const result = await selected.requestDevice({});
    assert.equal(result, device);
    result.createShaderModule({ label: 'example', code: 'invalid' });
    assert.equal(result.createRenderPipeline({ label: 'render' }), pipeline);
    const descriptor = { label: 'compute' };
    const pending = result.createComputePipelineAsync(descriptor);
    descriptor.label = 'reset by renderer';
    assert.equal(await pending, pipeline);
    assert.ok(events.some(event => event.phase === 'pipeline-ready' && event.label === 'compute'));
    callbacks.get('uncapturederror')({ error: { name: 'GPUValidationError', message: 'invalid buffer' } });
    lost({ reason: 'unknown', message: 'Instance dropped' });
    await new Promise(resolve => setTimeout(resolve, 0));
    for (const phase of [
      'adapter-ready',
      'device-ready',
      'shader-module',
      'shader-error',
      'pipeline-ready',
      'gpu-error',
      'device-lost',
    ]) {
      assert.ok(
        events.some(event => event.phase === phase),
        phase,
      );
    }
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
    delete globalThis.rzmpsPreviewReport;
  }
});

test('progress and stderr survive failure and optional GPU diagnostics can fail safely', async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'rzmps-preview-diagnostics-'));
  const bindings = new Map();
  let stderr;
  const browser = {
    version: async () => 'Chrome/test',
    on: () => {},
    process: () => ({
      stderr: {
        on: (_name, callback) => {
          stderr = callback;
        },
      },
    }),
    target: () => ({
      createCDPSession: async () => {
        throw new Error('GPU process unavailable');
      },
    }),
  };
  const page = {
    exposeFunction: async (name, callback) => bindings.set(name, callback),
    evaluateOnNewDocument: async () => {},
    on: () => {},
  };
  try {
    const diagnostics = await attachBrowserDiagnostics(
      browser,
      page,
      { example: 'fixture', backend: 'webgpu', output },
      [],
    );
    await diagnostics.snapshot();
    await bindings.get('rzmpsPreviewReport')({ phase: 'warmup-submit', step: 30 });
    stderr(Buffer.from('GPU process crashed'));
    await diagnostics.save();
    const saved = JSON.parse(await fs.readFile(path.join(output, 'diagnostics.json'), 'utf8'));
    assert.equal(saved.progress.step, 30);
    assert.match(saved.systemInfoError, /unavailable/);
    assert.match(await fs.readFile(path.join(output, 'chromium.log'), 'utf8'), /GPU process crashed/);
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});
