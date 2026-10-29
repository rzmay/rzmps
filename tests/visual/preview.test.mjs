import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseOptions, capturePreview } from '../../scripts/preview/capture.mjs';
test('preview arguments reject invalid counts, backends and timesteps',()=>{
 for(const args of [['--frames','0'],['--backend','unknown'],['--warmup','-1'],['--delta-time','NaN'],['--unknown',
   '1'],['--camera-position','1,2'],['--camera-fov','180'],['--scene-light-strength','-1'],
   ['--scene-light-strength','NaN']])assert.throws(()=>parseOptions(args));
});
for(const backend of ['webgl','webgpu'])for(const example of ['fire',
  'cubes'])test(`${backend}: ${example} exports canvas PNGs and diagnostics`,{timeout:240000},async()=>{
 const output=process.env.RZMPS_PREVIEW_OUTPUT ? path.resolve(process.env.RZMPS_PREVIEW_OUTPUT,backend,
   example) : await fs.mkdtemp(path.join(os.tmpdir(),`rzmps-${backend}-`));
 try {
  const metadata=await capturePreview(parseOptions(['--example',example,'--backend',backend,'--frames','2',
    '--interval','5','--warmup','10','--width','320','--height','240','--output',output]));
  assert.equal(metadata.status,'complete');assert.equal(metadata.captures.length,2);
  assert.equal(metadata.captures[0].step,10);assert.equal(metadata.captures[1].step,15);
  assert.ok(metadata.captures[0].particles>0);
  const png=await fs.readFile(path.join(output,'contact-sheet.png'));assert.ok(png.length>1000);
 } finally {if(!process.env.RZMPS_PREVIEW_OUTPUT)await fs.rm(output,{recursive:true,force:true});}
});

for (const backend of ['webgl',
  'webgpu']) test(`${backend}: registered decal origins keep smoke and bubbling subsystems active`, {
  timeout: 240000 }, async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), `rzmps-acid-${backend}-`));
  try {
    const metadata = await capturePreview(parseOptions(['--example', 'acid', '--backend', backend,
      '--scene', 'Checkerboard', '--warmup', '900', '--frames', '3', '--interval', '30',
      '--width', '320', '--height', '240', '--output', output]));
    assert.equal(metadata.status, 'complete');
    const systems = metadata.captures.at(-1).systems;
    for (const name of ['Pool Smoke', 'Pool Bubbles']) {
      const child = systems.find(s => s.name === name);
      assert.ok(child?.simulated > 0, `${name} must emit from registered decals`);
      assert.equal(child.gpuProcessingActive, backend === 'webgpu');
    }
    assert.ok(metadata.shaderBindings.every(s => s.maxStorageBuffers <= 8));
  } finally { await fs.rm(output, { recursive: true, force: true }); }
});

for (const backend of ['webgl', 'webgpu']) test(`${backend}: fireflies emit neighbor-driven attached light pulses`,
  { timeout: 240000 }, async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'rzmps-fireflies-'));
  try {
    const metadata = await capturePreview(parseOptions(['--example', 'fireflies', '--backend', backend,
      '--warmup', '180', '--frames', '6', '--interval', '30', '--width', '320', '--height', '240',
      '--scene', 'Checkerboard', '--scene-light-strength', '0.08',
      '--camera-position', '15,10,23', '--camera-target', '0,3,0',
      '--output', output]));
    assert.equal(metadata.status, 'complete');
    const populations = metadata.captures.map(frame => {
      const parent = frame.systems.find(s => s.name === 'Fireflies');
      const glow = frame.systems.find(s => s.name === 'Firefly Pulses');
      assert.equal(parent.gpuProcessingActive, backend === 'webgpu');
      assert.ok(parent.simulated >= 80 && parent.simulated <= 96,
        'the kill margin must preserve the initial swarm while replacements fill the capped population');
      assert.equal(glow.gpuProcessingActive, backend === 'webgpu');
      if (backend === 'webgpu') assert.equal(parent.events.readbackCount, 0);
      assert.equal(glow.lights.count, 16);
      assert.ok(Number.isFinite(glow.lights.peakIntensity));
      assert.ok(glow.lights.peakIntensity <= 0.521);
      return glow.simulated;
    });
    assert.ok(populations.some(count => count > 0), 'threshold crossings must create glow particles');
    assert.ok(populations.every(count => count < 48), 'sparse neighbors must avoid population-wide pulse waves');
    assert.ok(metadata.captures.some(frame => frame.systems.find(s => s.name === 'Firefly Pulses').lights.active > 0),
      'pulse lights must actually illuminate the scene');
    assert.ok(metadata.shaderBindings.every(s => s.maxStorageBuffers <= 8));
  } finally { await fs.rm(output, { recursive: true, force: true }); }
});

for (const backend of ['webgl', 'webgpu']) test(`${backend}: particle.kill emits one death in stored and fused updates`,
  { timeout: 240000 }, async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'rzmps-kill-'));
  try {
    const metadata = await capturePreview(parseOptions(['--example', 'gpuKill', '--backend', backend,
      '--warmup', '36', '--frames', '3', '--interval', '10', '--width', '320', '--height', '240', '--output', output]));
    for (const frame of metadata.captures) {
      const parent = frame.systems.find(s => s.name === 'Kill Origins');
      const markers = frame.systems.find(s => s.name === 'Kill Death Markers');
      assert.equal(parent.simulated, 0);
      assert.equal(markers.simulated, 2, 'each killed particle must emit exactly one death marker');
      assert.equal(parent.gpuProcessingActive, backend === 'webgpu');
      assert.equal(markers.gpuProcessingActive, backend === 'webgpu');
      if (backend === 'webgpu') assert.equal(parent.events.readbackCount, 0);
    }
  } finally { await fs.rm(output, { recursive: true, force: true }); }
});

test('webgpu: three-vector custom payload drives persistent runs without event readback', { timeout: 240000 },
  async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'rzmps-native-events-'));
  try {
    const metadata = await capturePreview(parseOptions(['--example', 'nativeEvents', '--backend', 'webgpu',
      '--warmup', '90', '--frames', '3', '--interval', '20', '--width', '320', '--height', '240', '--output', output]));
    assert.equal(metadata.status, 'complete');
    for (const frame of metadata.captures) {
      const parent = frame.systems.find(s => s.name === 'Native Event Origins');
      const child = frame.systems.find(s => s.name === 'GPU Payload Splashes');
      assert.equal(parent.gpuProcessingActive, true);
      assert.equal(parent.events.readbackCount, 0);
      assert.ok(child.simulated > 0);
      assert.equal(child.gpuProcessingActive, true);
    }
    const nested = metadata.captures.at(-1).systems.find(s => s.name === 'Nested Splash Flecks');
    assert.ok(nested?.simulated > 0, 'event-born GPU particles must drive nested death emission');
    assert.equal(nested.gpuProcessingActive, true);
    assert.ok(metadata.shaderBindings.every(s => s.maxStorageBuffers <= 8));
  } finally { await fs.rm(output, { recursive: true, force: true }); }
});
