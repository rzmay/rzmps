import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoverExamples, root } from './examples.mjs';
import { checksum, previewDirectory, previewInputs, readPreviewManifest } from './preview-manifest.mjs';
export async function generatePreviews({ force = false } = {}) {
  const examples = discoverExamples();
  const inputs = previewInputs(examples);
  const manifest = readPreviewManifest();
  const settings = JSON.parse(await fs.readFile(path.join(root,'scripts/docs/preview-settings.json'),'utf8'));
  await fs.mkdir(previewDirectory,{recursive:true});
  let capture;
  for (const example of examples) {
    const destination = path.join(previewDirectory,example.id+'.png');
    const entry = manifest.examples[example.id];
    const current = await fs.readFile(destination).catch(() => null);
    if (!force && entry?.inputHash === inputs.get(example.id) && current && entry.imageHash === checksum(current)) {
      console.log(`${example.id}: preview is current`);
      continue;
    }
    if (!capture) {
      // Capture local source changes, including a clean checkout with no package build artifacts.
      execFileSync('npm', ['run', 'build:modules'], { cwd: root, stdio: 'inherit' });
      capture = await import('../preview/capture.mjs');
    }
    const output = await fs.mkdtemp(path.join(os.tmpdir(),'rzmps-doc-preview-'));
    try {
      const config = { ...settings.defaults, ...settings.examples[example.id], example:example.id, output };
      const options = capture.parseOptions(Object.entries(config).flatMap(([key,value]) => ['--'+key,String(value)]));
      const result = await capture.capturePreview(options);
      const image = await fs.readFile(path.join(output,'frame-000.png'));
      await fs.writeFile(destination,image);
      manifest.examples[example.id] = {
        inputHash: inputs.get(example.id), imageHash: checksum(image),
        backend: options.backend, width: options.width, height: options.height,
        capture: result.captures[0], camera: result.camera,
        warnings: result.warnings.map(w => w.replace(/http:\/\/127\.0\.0\.1:\d+/g,'http://localhost')),
      };
    } finally { await fs.rm(output,{recursive:true,force:true}); }
    // Save progress so a failed example never discards completed captures.
    manifest.examples = Object.fromEntries(Object.entries(manifest.examples).sort(([a],[b]) => a.localeCompare(b,'en')));
    await fs.writeFile(path.join(previewDirectory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  }
  for (const id of Object.keys(manifest.examples)) if (!inputs.has(id)) {
    delete manifest.examples[id];
    await fs.rm(path.join(previewDirectory,id+'.png'),{force:true});
  }
  await fs.writeFile(path.join(previewDirectory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generatePreviews({ force: process.argv.includes('--force') });
}
