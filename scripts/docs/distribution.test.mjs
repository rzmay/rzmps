import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSkill } from './skill-format.mjs';
import { resolveExample, discoverExamples, guideTemplate, validateGuide } from './examples.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { generateSkill } from './skill-source.mjs';
import { buildArtifacts } from './artifacts.mjs';
test('canonical documentation controls skill metadata, workflow, and portable reference links',()=>{
  const root=path.resolve(import.meta.dirname,'../..');
  const source=fs.readFileSync(path.join(root,'apps/docs/guides/ai-coding-assistants.md'),'utf8');
  const original=generateSkill(source);
  const changed=generateSkill(source.replace('Inspect the installed package version','Inspect the exact installed package version').replace('description: Build and debug','description: Configure and debug'));
  assert.notEqual(changed,original);
  assert.match(changed,/description: Configure and debug/);
  assert.match(changed,/Inspect the exact installed package version/);
  assert.match(changed,/\]\(references\/getting-started\.md\)/);
  assert.doesNotMatch(changed,/\]\(\.\.\/api\//);
  assert.throws(()=>generateSkill(source.replace('<!-- skill:instructions:end -->','')),/Missing canonical skill region/);
});
test('rebuildable artifacts including previews are ignored; installable skill and authored guides stay tracked',()=>{
  const root=path.resolve(import.meta.dirname,'../..');
  const artifacts=[...buildArtifacts.map(file=>file.endsWith('/')?file+'index.md':file),
    'apps/docs/public/previews/fire.png','apps/docs/public/previews/manifest.json'];
  const retained=['.agents/skills/rzmps/SKILL.md','.agents/skills/rzmps/references/api.md','apps/docs/guides/concepts.md','apps/docs/examples/fire.md','README.md'];
  const ignored=execFileSync('git',['check-ignore','--no-index','--stdin'],{cwd:root,input:[...artifacts,...retained].join('\n')+'\n',encoding:'utf8'}).trim().split('\n');
  assert.deepEqual(ignored.sort(),artifacts.sort());
});
test('website discovers the canonical GitHub skill without a hosted duplicate',()=>{
  const root=path.resolve(import.meta.dirname,'../..');
  const discovery=fs.readFileSync(path.join(root,'apps/docs/public/llms.txt'),'utf8');
  assert.match(discovery,/npx skills add rzmay\/rzmps --skill rzmps/);
  assert.ok(discovery.includes('https://github.com/rzmay/rzmps/tree/HEAD/.agents/skills/rzmps'));
  assert.match(discovery,/user authorization/);
  assert.match(discovery,/## Optional[\s\S]+llms-full\.txt/);
  assert.doesNotMatch(discovery,/\/agent-skill\//);
  assert.equal(fs.existsSync(path.join(root,'apps/docs/public/agent-skill')),false);
});
test('example credit is resolved from the canonical factory author',()=>{
  const example=discoverExamples().find(e=>e.id==='fire');
  const rendered=resolveExample('<ExampleAttribution />\n<ExamplePreview />',example);
  assert.match(rendered,/Preset by \[rzmay\]\(https:\/\/github.com\/rzmay\)/);
  assert.match(rendered,/\/previews\/fire.png/);
});
test('example guides require generated preview and attribution components',()=>{
  const example=discoverExamples().find(e=>e.id==='fire');
  const template=guideTemplate(example);
  for(const component of ['ExamplePreview','ExampleAttribution']) {
    assert.throws(()=>validateGuide(template.replace(`<${component} />`,''),example,false),new RegExp(`missing ${component}`));
  }
});
test('skill format validates YAML and rejects broken references',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rzmps-skill-format-'));
  const file=path.join(directory,'SKILL.md');
  const description='Three.js particle systems and VFX using emitters, modules, renderers, WebGL and WebGPU.';
  try {
    fs.writeFileSync(file,`---\nname: rzmps\ndescription: ${description}\n---\n\n[Reference](references/missing.md)\n`);
    assert.throws(()=>validateSkill(file),/invalid skill reference/);
    fs.mkdirSync(path.join(directory,'references'));fs.writeFileSync(path.join(directory,'references/missing.md'),'# Valid reference\n');
    assert.equal(validateSkill(file).name,'rzmps');
    fs.writeFileSync(file,'---\nname: [invalid\n---\n');assert.throws(()=>validateSkill(file),/invalid YAML/);
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
