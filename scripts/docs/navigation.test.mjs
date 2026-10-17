import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guideNavigation, guideIndex } from './navigation.mjs';
import { apiNavigation, apiIndex } from './api-structure.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const flatten = items => items.flatMap(item => item.items ? flatten(item.items) : [item]);

test('guide order separates tutorials, concepts, features, and project work; labels follow article titles', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rzmps-guide-navigation-'));
  try {
    fs.cpSync(path.join(root, 'apps/docs/guides'), directory, { recursive: true });
    const sections = guideNavigation(directory);
    assert.deepEqual(sections.map(section => section.text), ['Getting Started', 'Core Concepts', 'Feature Guides', 'Project & Deployment']);
    assert.deepEqual(sections[0].items.map(item => item.link), ['/guides/first-particle-system', '/guides/first-module', '/guides/first-spatial-effect']);
    assert.ok(sections[2].items.some(item => item.text === 'Using Tags'));
    const tags = path.join(directory, 'tags.md');
    fs.writeFileSync(tags, fs.readFileSync(tags, 'utf8').replace(/^# .+/, '# Selecting Particles with Tags'));
    assert.ok(flatten(guideNavigation(directory)).some(item => item.text === 'Selecting Particles with Tags'));
    assert.match(guideIndex(sections), /## Getting Started[\s\S]+## Core Concepts[\s\S]+## Feature Guides/);
    fs.writeFileSync(path.join(directory, 'forgotten-guide.md'), '# Forgotten Guide\n');
    assert.throws(() => guideNavigation(directory), /Guide missing from navigation/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('API navigation includes every class and type once, with core classes first and real particle modules', () => {
  const pages = new Map();
  const visit = directory => {
    for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, file.name);
      if (file.isDirectory()) visit(absolute);
      else if (file.name.endsWith('.md')) pages.set(path.relative(path.join(root, 'apps/docs/api'), absolute), fs.readFileSync(absolute, 'utf8'));
    }
  };
  visit(path.join(root, 'apps/docs/api'));
  const sections = apiNavigation(pages, fs.readFileSync(path.join(root, 'packages/rzmps/src/index.ts'), 'utf8'));
  const lookup = new Map(sections.map(section => [section.text, section]));
  for (const [section, first] of [['Particle Systems', 'ParticleSystem'], ['Emitters', 'Emitter'], ['Modules', 'Module'], ['Renderers', 'Renderer']]) {
    assert.equal(lookup.get(section).items[0].text, first);
  }
  assert.ok(flatten(lookup.get('Modules').items).some(item => item.text === 'Boids'));
  assert.ok(flatten(lookup.get('Helpers').items).some(item => item.text === 'ParticleOctree'));
  assert.equal(lookup.get('Types').items[0].items[0].text, 'ParticleSystemOptions');
  const actual = flatten(sections).map(item => item.link);
  const expected = [...pages.keys()].filter(file => /(?:^|\/)(classes|interfaces|enumerations|type-aliases)\/[^/]+\.md$/.test(file)).map(file => '/api/' + file.replace(/\.md$/, ''));
  assert.equal(actual.length, new Set(actual).size, 'each API entry has one primary navigation location');
  for (const link of expected) assert.ok(actual.includes(link), `unlisted API page: ${link}`);
  const index = apiIndex(sections);
  assert.match(index, /## Modules[\s\S]+\[Module\]\(classes\/Module.md\)/);
  assert.doesNotMatch(index, /Referenced types|## Classes|\.md\.md/);
});

test('new module exports are grouped automatically; unclassified classes fail visibly', () => {
  const pages = new Map([['classes/FutureModule.md', '# Class: FutureModule\n']]);
  const source = "export { default as FutureModule } from './modules/FutureModule';";
  const sections = apiNavigation(pages, source);
  assert.ok(flatten(sections.find(section => section.text === 'Modules').items).some(item => item.text === 'FutureModule'));
  assert.throws(() => apiNavigation(pages, ''), /API class needs a navigation section/);
});
