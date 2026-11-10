import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverExamples, readExampleMetadata } from '../../docs/examples.mjs';
import { previewArguments, previewDefaults } from '../../docs/preview-settings.mjs';
import { parseOptions } from '../../preview/capture.mjs';
import { resolveScene } from '../../preview/resolveScene.mjs';

test('example preview metadata supports scalar values, camera vectors and imported scene references', () => {
  const metadata = readExampleMetadata(`
    import sceneFactory from './scene.js';
    export default function fixture() {} fixture.metadata = { previewSettings: {
      scene: sceneFactory, warmup: 0, sceneLightStrength: 0.08,
      cameraPosition: [4, 0.5, -4], backend: 'webgpu'
    } };
  `);
  assert.deepEqual(metadata.previewSettings, {
    scene: { module: './scene.js', export: 'default' },
    warmup: 0,
    sceneLightStrength: 0.08,
    cameraPosition: [4, 0.5, -4],
    backend: 'webgpu',
  });
  assert.deepEqual(
    readExampleMetadata(`import { environment as scene } from './scene.js';
    export default function fixture() {} fixture.metadata = { previewSettings: { scene } };`),
    { previewSettings: { scene: { module: './scene.js', export: 'environment' } } },
  );
});

test('scene metadata rejects display names, unbound identifiers and executable expressions', () => {
  for (const scene of ["'Checkerboard'", 'missingFactory', 'createScene()']) {
    assert.throws(
      () =>
        readExampleMetadata(
          `export default function fixture() {} fixture.metadata = { previewSettings: { scene: ${scene} } };`,
        ),
      /imported scene factory|static literal/,
    );
  }
  assert.throws(
    () => readExampleMetadata('export default function fixture() {} fixture.metadata = { previewSettings: [] };'),
    /must be an object/,
  );
});

test('omitted preview settings inherit defaults; overrides preserve zero and serialize vectors', () => {
  const basic = parseOptions(previewArguments({ id: 'example' }, '/tmp/preview'));
  assert.equal(basic.backend, 'webgl');
  assert.equal(basic.width, previewDefaults.width);
  assert.equal(basic.height, previewDefaults.height);
  assert.equal(basic.scene, null);
  const custom = parseOptions(
    previewArguments(
      {
        id: 'example',
        previewSettings: {
          backend: 'webgpu',
          warmup: 0,
          cameraPosition: [4, 2, -4],
          sceneLightStrength: 0,
          scene: { module: './scene.js', export: 'default' },
        },
      },
      '/tmp/preview',
    ),
  );
  assert.equal(custom.warmup, 0);
  assert.equal(custom.sceneLightStrength, 0);
  assert.equal(custom.backend, 'webgpu');
  assert.deepEqual(custom.cameraPosition, [4, 2, -4]);
  assert.equal(custom.scene, null, 'scene factory is resolved from browser-side example metadata');
});

test('scene resolution uses the actual factory and preserves explicit CLI precedence', () => {
  const preferred = () => {};
  const override = () => {};
  assert.equal(resolveScene(null, preferred, {}), preferred);
  assert.equal(resolveScene('other', preferred, { other: override }), override);
  assert.equal(resolveScene(null, undefined, {}), null);
  assert.throws(() => resolveScene('missing', preferred, {}), /Unknown scene/);
  assert.throws(() => resolveScene(null, 'Checkerboard', {}), /scene factory/);
});

test('all canonical example overrides pass capture option validation', () => {
  const examples = discoverExamples();
  for (const example of examples) parseOptions(previewArguments(example, '/tmp/preview'));
  assert.equal(examples.find(example => example.id === 'fireflies').previewSettings.backend, 'webgpu');
  assert.ok(examples.find(example => example.id === 'fire').previewSettings.scene.module.endsWith('checkerboard.js'));
});

test('metadata permits wrapped static strings without evaluating expressions', () => {
  const source = 'export default function fixture() {} fixture.metadata = {description: "long " + "description"};';
  assert.equal(readExampleMetadata(source).description, 'long description');
  assert.throws(() => readExampleMetadata(source.replace('"description"', 'getDescription()')), /static literal/);
});
