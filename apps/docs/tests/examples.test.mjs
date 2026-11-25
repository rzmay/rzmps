import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { extractRegions, resolveCode, guideTemplate, validateGuide, discoverExamples } from '../scripts/examples.mjs';

test('nested, repeated, named regions preserve real source and exclude only marker lines', () => {
  const source = [
    '// #region docs:system',
    '// #region docs:modules:rocket',
    'const rocketModules = [',
    '  actualSource(),',
    '];',
    '// #endregion docs:modules:rocket',
    'const system = { modules: rocketModules };',
    '// #endregion docs:system',
    '// #region docs:modules:rocket',
    '  extra();',
    '// #endregion docs:modules:rocket',
  ].join('\n');
  const regions = extractRegions(source);
  assert.equal(
    regions.get('system')[0].code,
    'const rocketModules = [\n  actualSource(),\n];\nconst system = { modules: rocketModules };',
  );
  const output = resolveCode('<ExampleCode region="modules" />', { id: 'fixture', file: 'fixture.js', regions });
  assert.match(output, / {2}actualSource\(\),/);
  assert.match(output, /\nextra\(\);/);
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

test('example guides allow intent-led headings, combined source groups and reordered construction', () => {
  const example = discoverExamples().find(example => example.id === 'fire');
  const header = guideTemplate(example).split('## ')[0];
  const body = `## Give the flame a warm footprint

Make the light and surface marks reinforce the rising flame, rather than treating each renderer as an unrelated feature.

<ExampleCode region="renderers:1" />
<ExampleCode region="emitters:1" />

## Shape the rise

Noise breaks up a regular stream while upward force preserves its direction. Tune this before adding the heat layer.

<ExampleCode region="modules:1" />
`;
  assert.doesNotThrow(() => validateGuide(header + body, example));
  assert.throws(
    () => validateGuide(header + body.replace('renderers:1', 'missing-region'), example),
    /missing source region/,
  );
  assert.throws(
    () => validateGuide(header + '## Motion\n\n<ExampleCode region="modules:1" />', example),
    /explanation/,
  );
  assert.throws(
    () => validateGuide(header + '## Motion\n\nExplain the effect without source code.', example),
    /source reference/,
  );
});

test('every authored example guide has explained, resolving references to its actual preset', () => {
  for (const example of discoverExamples()) {
    const file = path.resolve(import.meta.dirname, '../examples', example.id + '.md');
    validateGuide(fs.readFileSync(file, 'utf8'), example);
  }
});

test('source excerpts include relevant actual imports without duplicating imports already in the region', () => {
  const source = `import { Curve as Envelope, NumberKeyframe, Unused } from 'curves';
import { Easing } from 'eaz';
// #region docs:modules
const opacity = new Envelope([new NumberKeyframe(0, 0, Easing.cubic)]);
const modules = [new ColorOverLifetime({ alpha: time => opacity.evaluate(time) })];
// #endregion docs:modules`;
  const example = { id: 'fixture', file: 'fixture.js', source, regions: extractRegions(source) };
  const output = resolveCode('<ExampleCode region="modules" />', example);
  assert.match(output, /import \{ Curve as Envelope, NumberKeyframe \} from 'curves';/);
  assert.match(output, /import \{ Easing \} from 'eaz';/);
  assert.doesNotMatch(output, /Unused/);
  assert.equal((output.match(/```js/g) ?? []).length, 1);
  assert.ok(output.includes('const opacity') && output.includes('const modules'));

  const inlineSource = `// #region docs:modules
import { Easing } from 'eaz';
const fade = time => Easing.cubic.in(time);
// #endregion docs:modules`;
  const inline = resolveCode('<ExampleCode region="modules" />', {
    id: 'fixture',
    file: 'fixture.js',
    source: inlineSource,
    regions: extractRegions(inlineSource),
  });
  assert.equal((inline.match(/import \{ Easing \}/g) ?? []).length, 1);
});

test('every canonical source excerpt is a complete JavaScript module', { timeout: 30000 }, () => {
  for (const example of discoverExamples()) {
    for (const [region] of example.regions) {
      const markdown = resolveCode(`<ExampleCode region="${region}" />`, example);
      for (const [, code] of markdown.matchAll(/```js\n([\s\S]*?)\n```/g)) {
        const parsed = spawnSync(process.execPath, ['--check', '--input-type=module'], {
          input: code,
          encoding: 'utf8',
          timeout: 5000,
        });
        assert.equal(parsed.status, 0, `${example.file} docs:${region}: ${parsed.stderr || parsed.error}`);
      }
    }
  }
});

test('source rendering rejects object-member and return fragments', () => {
  for (const code of ['modules: [new FooModule()],', 'return new ParticleSystem();']) {
    const example = { id: 'fixture', regions: new Map([['modules', [{ code, line: 1 }]]]) };
    assert.throws(() => resolveCode('<ExampleCode region="modules" />', example), /complete JavaScript statements/);
  }
});
