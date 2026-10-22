import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseOptions, capturePreview } from '../../scripts/preview/capture.mjs';
test('preview arguments reject invalid counts, backends and timesteps',()=>{
 for(const args of [['--frames','0'],['--backend','unknown'],['--warmup','-1'],['--delta-time','NaN'],['--unknown','1'],['--camera-position','1,2'],['--camera-fov','180']])assert.throws(()=>parseOptions(args));
});
for(const backend of ['webgl','webgpu'])for(const example of ['fire','cubes'])test(`${backend}: ${example} exports canvas PNGs and diagnostics`,{timeout:240000},async()=>{
 const output=process.env.RZMPS_PREVIEW_OUTPUT ? path.resolve(process.env.RZMPS_PREVIEW_OUTPUT,backend,example) : await fs.mkdtemp(path.join(os.tmpdir(),`rzmps-${backend}-`));
 try {
  const metadata=await capturePreview(parseOptions(['--example',example,'--backend',backend,'--frames','2','--interval','5','--warmup','10','--width','320','--height','240','--output',output]));
  assert.equal(metadata.status,'complete');assert.equal(metadata.captures.length,2);
  assert.equal(metadata.captures[0].step,10);assert.equal(metadata.captures[1].step,15);
  assert.ok(metadata.captures[0].particles>0);
  const png=await fs.readFile(path.join(output,'contact-sheet.png'));assert.ok(png.length>1000);
 } finally {if(!process.env.RZMPS_PREVIEW_OUTPUT)await fs.rm(output,{recursive:true,force:true});}
});
