import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUPPETEER_REVISIONS } from 'puppeteer';
import { discoverExamples } from './examples.mjs';
import { previewDirectory, validatePreviews } from './preview-manifest.mjs';
import { inspectMedia, toolVersions } from '../preview/media.mjs';

export async function validateAssets(directory = previewDirectory) {
  const examples = discoverExamples();
  validatePreviews(examples, directory, { ...toolVersions(), chrome: PUPPETEER_REVISIONS.chrome });
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  for (const example of examples) {
    const entry = manifest.examples[example.id];
    await inspectMedia(path.join(directory, example.id + '.png'), entry, { image: true });
    await inspectMedia(path.join(directory, example.id + '.' + entry.format), entry);
  }
  console.log(`Validated posters and videos for ${examples.length} examples in ${directory}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await validateAssets(process.argv[2]);
