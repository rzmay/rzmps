import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root } from './examples.mjs';
import { previewDefaults } from './preview-settings.mjs';
export const previewDirectory = path.join(root, 'apps/docs/public/previews');
export function checksum(value) {
  return createHash('sha256').update(value).digest('hex');
}
function tree(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .flatMap(entry => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? tree(file) : [file];
    });
}
export function previewInputs(examples, tools = {}) {
  const sharedFiles = [
    ...['rzmps', 'ammo', 'jolt', 'rapier'].flatMap(name => tree(path.join(root, 'packages', name, 'src'))),
    ...tree(path.join(root, 'examples/assets')),
    ...tree(path.join(root, 'examples/scenes')),
    ...tree(path.join(root, 'examples/utils')),
    ...tree(path.join(root, 'apps/demo/src/rendering')),
    ...tree(path.join(root, 'scripts/preview')),
    ...[
      'scripts/docs/generate-previews.mjs',
      'scripts/docs/preview-settings.mjs',
      'apps/demo/vite.config.mjs',
      'package-lock.json',
    ].map(f => path.join(root, f)),
  ];
  const common = createHash('sha256').update(JSON.stringify(tools));
  for (const file of sharedFiles) common.update(path.relative(root, file)).update(fs.readFileSync(file));
  const sharedHash = common.digest('hex');
  return new Map(
    examples.map(example => [
      example.id,
      checksum(sharedHash + fs.readFileSync(path.join(root, 'examples', example.file), 'utf8')),
    ]),
  );
}
export function readPreviewManifest() {
  const file = path.join(previewDirectory, 'manifest.json');
  return fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : { generatedBy: 'npm run docs:previews', examples: {} };
}
/** Validate cache identity and both media hashes before skipping expensive capture/encoding. */
export function previewIsCurrent(entry, inputHash, files) {
  if (
    !entry ||
    entry.inputHash !== inputHash ||
    entry.backend !== entry.actualBackend ||
    !['mp4', 'webm'].includes(entry.format)
  )
    return false;
  const names = Object.keys(entry.files ?? {});
  if (!names.some(name => name.endsWith('.png')) || !names.some(name => name.endsWith('.' + entry.format)))
    return false;
  return names.every(
    name => path.basename(name) === name && files?.[name] && checksum(files[name]) === entry.files[name],
  );
}
export function validatePreviews(examples, directory = previewDirectory, tools = {}) {
  if (!fs.existsSync(path.join(directory, 'manifest.json')))
    throw new Error('Preview manifest is missing; run npm run docs:previews');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const inputs = previewInputs(examples, tools);
  for (const example of examples) {
    const entry = manifest.examples[example.id];
    const settings = { ...previewDefaults, ...example.previewSettings };
    if (
      !entry ||
      entry.backend !== settings.backend ||
      entry.format !== settings.format ||
      entry.width !== settings.width ||
      entry.height !== settings.height ||
      entry.fps !== settings.fps ||
      entry.frames !== (settings.frames ?? Math.round(settings.duration * settings.fps))
    ) {
      throw new Error(`${example.id}: media configuration does not match example metadata`);
    }
    if (entry.inputHash !== inputs.get(example.id) || entry.backend !== entry.actualBackend) {
      throw new Error(`${example.id}: missing/stale preview or incorrect backend; run npm run docs:previews`);
    }
    for (const [file, hash] of Object.entries(entry.files ?? {})) {
      if (
        path.basename(file) !== file ||
        !fs.existsSync(path.join(directory, file)) ||
        checksum(fs.readFileSync(path.join(directory, file))) !== hash
      )
        throw new Error(`${example.id}: missing or corrupt ${file}`);
    }
    if (!entry.files?.[example.id + '.png'] || !entry.files?.[example.id + '.' + entry.format]) {
      throw new Error(`${example.id}: poster and video are required`);
    }
  }
  for (const id of Object.keys(manifest.examples))
    if (!inputs.has(id)) throw new Error(`Stale preview for removed example ${id}`);
}
