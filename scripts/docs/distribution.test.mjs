import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSkill } from './skill-format.mjs';
import { resolveExample, discoverExamples, guideTemplate, validateGuide } from './examples.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
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
