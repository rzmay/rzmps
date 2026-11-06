import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root } from './examples.mjs';
export const previewDirectory = path.join(root, 'apps/docs/public/previews');
export function checksum(value) { return createHash('sha256').update(value).digest('hex'); }
function tree(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => !entry.name.startsWith('.')).sort((a,b) => a.name.localeCompare(b.name, 'en')).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? tree(file) : [file];
  });
}
export function previewInputs(examples) {
  const sharedFiles = [
    ...tree(path.join(root, 'packages/rzmps/src')),
    ...tree(path.join(root, 'apps/demo/src/assets')),
    ...tree(path.join(root, 'apps/demo/src/presets/scenes')),
    ...tree(path.join(root, 'apps/demo/src/rendering')),
    ...['scripts/preview/capture.mjs', 'scripts/preview/harness.js', 'scripts/docs/preview-settings.json', 'apps/demo/vite.config.mjs', 'package-lock.json'].map(f => path.join(root, f)),
  ];
  const common = createHash('sha256');
  for (const file of sharedFiles) common.update(path.relative(root,file)).update(fs.readFileSync(file));
  const sharedHash = common.digest('hex');
  return new Map(examples.map(example => [example.id, checksum(sharedHash + fs.readFileSync(path.join(root, 'examples', example.file), 'utf8'))]));
}
export function readPreviewManifest() {
  const file = path.join(previewDirectory,'manifest.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : { generatedBy: 'npm run docs:previews', examples: {} };
}
/** Shared cache validation for explicit generation and browser-free build checks. */
export function previewIsCurrent(entry, inputHash, image) {
  return !!(entry && entry.inputHash === inputHash && image && entry.imageHash === checksum(image));
}
export function validatePreviews(examples) {
  const manifest = readPreviewManifest();
  const inputs = previewInputs(examples);
  for (const example of examples) {
    const entry = manifest.examples[example.id];
    const file = path.join(previewDirectory, example.id+'.png');
    const image = fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (!previewIsCurrent(entry, inputs.get(example.id), image)) {
      throw new Error(`${example.id}: missing or stale preview; run npm run docs:generate`
        + ' and commit apps/docs/public/previews/ with your changes.');
    }
  }
  for (const id of Object.keys(manifest.examples)) if (!inputs.has(id)) throw new Error(`Stale preview for removed example ${id}; run npm run docs:generate`);
}
