import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverExamples, resolveExample } from '../../docs/examples.mjs';
import { exampleSEO } from '../../docs/seo.mjs';
import { filterExamples } from '../../../examples/utils/search.js';
import { previewInputs } from '../../docs/preview-manifest.mjs';
import fs from 'node:fs';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';

test('all examples have canonical SEO, absolute social URLs and searchable visible metadata', () => {
  const examples = discoverExamples();
  for (const example of examples) {
    const head = exampleSEO(example);
    assert.equal(head.filter(([tag, attrs]) => tag === 'link' && attrs.rel === 'canonical').length, 1);
    for (const [,attrs] of head) if (attrs.property?.match(/^og:(image|video)(:secure_url)?$/)) assert.match(attrs.content, /^https:\/\//);
    assert.ok(head.some(([,attrs]) => attrs.property === 'og:video:type' && attrs.content === 'video/mp4'));
    const text = resolveExample('<ExampleAttribution />\n<ExamplePreview />', example);
    for (const term of [example.category,...example.tags]) assert.ok(text.includes(term));
    for (const term of [example.title,example.description,example.category,...example.tags,example.author.name]) {
      assert.ok(filterExamples(examples,term.toUpperCase()).includes(example));
    }
    assert.ok(text.includes('<ExampleVideo'));
  }
  assert.equal(filterExamples(examples,'a term no example contains 928347').length,0);
  assert.equal(filterExamples(examples,'  ').length,examples.length);
});
test('tool versions invalidate cached media without changing source', () => {
  const examples = discoverExamples().slice(0,1);
  assert.notEqual(previewInputs(examples,{ffmpeg:'v1'}).values().next().value,
    previewInputs(examples,{ffmpeg:'v2'}).values().next().value);
});
test('Vue player compiles for browser and server rendering', () => {
  const source = fs.readFileSync(new URL('../../../apps/docs/.vitepress/theme/ExampleVideo.vue',import.meta.url),'utf8');
  const { descriptor, errors } = parse(source);
  assert.deepEqual(errors, []);
  const script = compileScript(descriptor,{id:'preview'});
  for (const ssr of [false,true]) {
    const result = compileTemplate({id:'preview',filename:'ExampleVideo.vue',source:descriptor.template.content,
      ssr,ssrCssVars:[],compilerOptions:{bindingMetadata:script.bindings}});
    assert.deepEqual(result.errors,[]);
  }
});

test('deployment cache restores only bounded, hash-checked media and treats missing cache as a miss', async () => {
  const { restorePreviews } = await import('../../docs/restore-previews.mjs');
  const { checksum } = await import('../../docs/preview-manifest.mjs');
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(),'rzmps-cache-test-'));
  try {
    const bytes = Buffer.from('test-media');
    const manifest = {examples:{fixture:{files:{'fixture.png':checksum(bytes),'fixture.mp4':checksum(bytes)}}}};
    const fetcher = async url => new Response(url.pathname.endsWith('manifest.json') ? JSON.stringify(manifest) : bytes);
    await restorePreviews({directory,fetcher});
    assert.deepEqual(await fsp.readFile(path.join(directory,'fixture.mp4')),bytes);
    await fsp.rm(path.join(directory,'manifest.json'));
    await restorePreviews({directory,fetcher:async()=>new Response('',{status:404})});
    await assert.rejects(fsp.access(path.join(directory,'manifest.json')));
  } finally {await fsp.rm(directory,{recursive:true,force:true});}
});

test('demo example routes use imported preferred scene factories while explicit scene and renderer win', async () => {
  const { resolveDemoSelection } = await import('examples/utils/resolveDemoSelection.js');
  const preferred = () => {}, other = () => {};
  const examples = [{id:'fire',title:'Fire',previewSettings:{scene:preferred,backend:'webgpu'}}];
  const scenes = {Preferred:{create:preferred},Other:{create:other}};
  for (const route of ['fire','fire/','fire.html','fire/index.html']) assert.deepEqual(resolveDemoSelection(new URL('https://test/example/' + route),examples,scenes),
    {preset:'Fire',scene:'Preferred',backend:'webgpu'});
  assert.deepEqual(resolveDemoSelection(new URL('https://test/?preset=Fire&scene=Other&renderer=webgl'),examples,scenes),
    {preset:'Fire',scene:'Other',backend:'webgl'});
});

test('VitePress raw-Markdown search renderer indexes tags and respects search exclusions', async () => {
  const {createMarkdownRenderer} = await import('vitepress');
  const {renderSearchPage} = await import('../../docs/search.mjs');
  const markdown = await createMarkdownRenderer(process.cwd());
  const example = discoverExamples().find(entry => entry.id === 'fire');
  const raw = fs.readFileSync(new URL('../../../apps/docs/examples/fire.md',import.meta.url),'utf8');
  const html = renderSearchPage(raw.replace(example.description, ''),{},markdown);
  assert.ok(html.includes(example.description), 'metadata description is indexed even if authored prose differs');
  for (const tag of example.tags) assert.ok(html.includes(tag));
  assert.ok(html.includes('Category:'));
  assert.equal(renderSearchPage('---\nsearch: false\n---\n# Hidden',{},markdown),'');
  assert.match(renderSearchPage('# Normal guide',{},markdown),/Normal guide/);
});
