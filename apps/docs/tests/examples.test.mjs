import assert from 'node:assert/strict';
import test from 'node:test';
import { extractRegions, resolveCode, guideTemplate, validateGuide, discoverExamples } from '../scripts/examples.mjs';

test('nested, repeated, named regions preserve real source and exclude only marker lines', () => {
  const source =
    '// #region docs:system\nconst system = {\n// #region docs:modules:rocket\n  ' +
    'modules: [],\n// #endregion docs:modules:rocket\n};\n// #endregion ' +
    'docs:system\n// #region docs:modules:rocket\n  extra();\n// #endregion ' +
    'docs:modules:rocket';
  const regions = extractRegions(source);
  assert.equal(regions.get('system')[0].code, 'const system = {\n  modules: [],\n};');
  const output = resolveCode('<ExampleCode region="modules" />', { id: 'fixture', file: 'fixture.js', regions });
  assert.match(output, / {2}modules: \[\],/);
  assert.match(output, / {2}extra\(\);/);
  assert.equal((output.match(/```js/g) || []).length, 2);
});
test('malformed or misleading regions fail clearly', () => {
  for (const source of [
    '// #region docs:system\nx',
    '// #endregion docs:system',
    '// #region docs:system\n// #endregion docs:system',
    '// #region docs:system\n// #region docs:emitters\nx\n// #endregion docs:system',
    '// #region docs:bad name\nx\n// #endregion docs:bad name',
  ])
    assert.throws(() => extractRegions(source), /region/);
  assert.throws(
    () => resolveCode('<ExampleCode region="missing" />', { id: 'fixture', regions: new Map() }),
    /missing source region/,
  );
});
test('new guide templates require human explanations', () => {
  const example = {
    id: 'fixture',
    title: 'Fixture',
    description: 'Description',
    regions: new Map(
      ['system', 'emitters', 'modules', 'renderers'].map(key => [key, [{ code: 'actualSource();', line: 1 }]]),
    ),
  };
  const template = guideTemplate(example);
  assert.match(template, /TODO/);
  assert.doesNotMatch(template, /actualSource/);
  assert.throws(() => validateGuide(template, example), /explanation|TODO/);
  assert.throws(() => validateGuide(template, { ...example, id: 'renamed-example' }, false), /stale live example/);
});
test('all canonical examples are discoverable and structurally valid', () => {
  const examples = discoverExamples();
  assert.ok(examples.length >= 20);
  assert.ok(examples.some(e => e.id === 'fireworks'));
});

test('walkthrough guides keep explanations and component coverage with intention-led headings', () => {
  const example = {
    id: 'fixture',
    regions: new Map(['system', 'emitters:beam', 'modules:noise', 'renderers:glow']
      .map(key => [key, [{ code: 'actualSource();', line: 1 }]])),
  };
  const guide = '[View live example](https://rzmps.rzmay.com/example/fixture)\n'
    + '<ExampleAttribution />\n<ExampleTags />\n<ExamplePreview />\n'
    + '## Build the beam\n\n'
    + 'Fast particles form the continuous beam, while animated offsets give its silhouette a jagged outline.\n\n'
    + '<ExampleCode region="system" />\n<ExampleCode region="emitters:beam" />\n'
    + '## Make it glow\n\n'
    + 'A bright core and wider soft halo make the moving beam read as concentrated energy against its surroundings.\n\n'
    + '<ExampleCode region="modules:noise" />\n<ExampleCode region="renderers:glow" />\n';
  assert.doesNotThrow(() => validateGuide(guide, example));
  assert.throws(() => validateGuide(guide.replace('<ExampleCode region="modules:noise" />', ''), example),
    /modules source reference/);
  assert.throws(() => validateGuide(guide.replace(
    'A bright core and wider soft halo make the moving beam read as concentrated energy against its surroundings.', ''),
  example), /needs an explanation/);
  assert.throws(() => validateGuide(guide.replace('renderers:glow', 'renderers:missing'), example),
    /missing source region/);
});
