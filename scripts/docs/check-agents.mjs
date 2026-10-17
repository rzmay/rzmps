import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateSkill } from './skill-format.mjs';
import { root } from './examples.mjs';
const source=process.argv.find(arg=>arg.startsWith('--source='))?.slice('--source='.length);
const github=process.argv.includes('--github');
const cli=path.join(root,'node_modules/skills/bin/cli.mjs');
function foundSkill(output) { return output.split('\n').some(line=>line.replace(/^[\s│◇●]+/,'').trim()==='rzmps'); }
function run(args,options={}) {
  return execFileSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:120000,env:{...process.env,DISABLE_TELEMETRY:'1',DO_NOT_TRACK:'1'},...options}).replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'');
}
if(github||source) {
  const target=source??'rzmay/rzmps';
  const output=run(['add',target,'--list'],{cwd:root});
  if(!foundSkill(output)||/No skills found|No valid skills/.test(output))throw new Error(`GitHub skill discovery did not find rzmps:\n${output}`);
  console.log(`GitHub discovery found rzmps in ${target}`);
} else {
  validateSkill(path.join(root,'.agents/skills/rzmps/SKILL.md'));
  validateSkill(path.join(root,'apps/docs/public/agent-skill/SKILL.md'));
  const temporary=await fsp.mkdtemp(path.join(os.tmpdir(),'rzmps-agent-check-'));
  try {
    const project=path.join(temporary,'project'),globalProject=path.join(temporary,'global-project'),testHome=path.join(temporary,'user');
    for(const directory of [project,globalProject,testHome])await fsp.mkdir(directory);
    const output=run(['add',root,'--list'],{cwd:project});
    if(!foundSkill(output)||/No skills found/.test(output))throw new Error('The actual checkout skill was not discoverable');
    // Node's os.homedir is isolated in a test-only preload. HOME and CODEX_HOME are never changed.
    // This prevents both the project install's user-level lock and the global install from touching real configuration.
    const preload=path.join(temporary,'isolated-user.cjs');
    await fsp.writeFile(preload,`const os=require('node:os'); os.homedir=()=>${JSON.stringify(testHome)}; require('node:module').syncBuiltinESMExports();\n`);
    const isolatedRun=(args,cwd)=>execFileSync(process.execPath,['--require',preload,cli,...args],{cwd,encoding:'utf8',timeout:120000,env:{...process.env,DISABLE_TELEMETRY:'1',DO_NOT_TRACK:'1'}});
    isolatedRun(['add',root,'--skill','rzmps','--agent','codex','--yes'],project);
    validateSkill(path.join(project,'.agents/skills/rzmps/SKILL.md'));
    isolatedRun(['add',root,'--skill','rzmps','-g','--agent','codex','--yes'],globalProject);
    validateSkill(path.join(testHome,'.agents/skills/rzmps/SKILL.md'));
    console.log('Actual checkout discovery, project installation, and global installation passed in temporary directories.');
  } finally {await fsp.rm(temporary,{recursive:true,force:true});}
  const packageRoot=path.join(root,'packages/rzmps');
  const pack=JSON.parse(execFileSync('npm',['pack','--dry-run','--json','--ignore-scripts'],{cwd:packageRoot,encoding:'utf8',timeout:120000}))[0];
  const files=pack.files.map(file=>file.path);
  for(const expected of ['AGENTS.md','README.md','build/index.d.ts'])if(!files.includes(expected))throw new Error(`npm package is missing ${expected}; build packages and regenerate docs`);
  for(const file of files)if(!/^(build\/|README\.md$|AGENTS\.md$|LICENSE(?:\.md)?$|package\.json$)/.test(file))throw new Error(`Unexpected npm payload: ${file}`);
  if(files.some(file=>/(^|\/)(\.agents|references)(\/|$)|SKILL\.md$/.test(file)))throw new Error('The full skill must not be bundled in npm');
  if(fs.statSync(path.join(packageRoot,'AGENTS.md')).size>4096)throw new Error('npm AGENTS.md must remain lightweight');
  const pkg=JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'),'utf8'));
  for(const hook of ['preinstall','install','postinstall'])if(pkg.scripts?.[hook])throw new Error(`Consumer installation hook ${hook} is not permitted`);
  console.log(`npm pack --dry-run passed: ${files.length} files, short AGENTS.md included, full skill excluded, no consumer install hooks.`);
}
