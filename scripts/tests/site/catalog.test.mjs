import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRegistry } from 'examples/utils/registry.js';
import { discoverExamples, exampleSourcePath, readExampleMetadata } from '../../docs/examples.mjs';

const root = path.resolve(import.meta.dirname, '../../..');

test('automatic catalogs preserve factory metadata and derive source links without mutating factories', () => {
  const factory = () => {};
  factory.metadata = { id: 'scene', title: 'Scene', author: 'rzmay' };
  const metadata = { ...factory.metadata };
  const [entry] = createRegistry({ './scene.js': factory }, 'scenes');
  assert.deepEqual(entry, { create: factory, ...metadata,
    sourceUrl: 'https://github.com/rzmay/rzmps/blob/develop/examples/scenes/scene.js' });
  assert.deepEqual(factory.metadata, metadata);
  assert.equal(factory.sourceUrl, undefined);
  assert.throws(() => createRegistry({ './a.js': factory, './b.js': factory }, 'scenes'), /duplicate/);
  assert.throws(() => createRegistry({ './invalid.js': () => {} }, 'scenes'), /factory.metadata/);
});

test('every scene supplies its own metadata and HDRI environments are independent scenes', () => {
  const files = fs.readdirSync(path.join(root, 'examples/scenes')).filter(file => file.endsWith('.js') && file !== 'index.js');
  const scenes = files.map(file => readExampleMetadata(fs.readFileSync(path.join(root, 'examples/scenes', file), 'utf8'), file));
  assert.ok(scenes.length >= 2);
  for (const scene of scenes) for (const field of ['id', 'title', 'author']) assert.ok(scene[field]);
  assert.equal(new Set(scenes.map(scene => scene.title)).size, scenes.length);
  assert.ok(scenes.some(scene => scene.title === 'Shanghai Bund HDRI'));
  assert.ok(scenes.some(scene => scene.title === 'Ferndale Studio HDRI'));
  assert.ok(!files.includes('hdri.js'));
});

test('documentation watches the actual preset source file instead of treating its index as a directory', () => {
  const example = discoverExamples().find(example => example.id === 'bubbles');
  const source = exampleSourcePath(example);
  assert.equal(source, path.join(root, 'examples/presets/bubbles.js'));
  assert.ok(fs.statSync(source).isFile());
  const config = fs.readFileSync(path.join(root, 'apps/docs/.vitepress/config.mts'), 'utf8');
  assert.ok(config.includes('this.addWatchFile(exampleSourcePath(example))'));
  assert.ok(!config.includes("'examples/index.js', example.file"));
});
