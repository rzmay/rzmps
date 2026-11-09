import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { runBenchmarkStage } from '../../benchmark/run-pr-benchmarks.mjs';
import { BENCHMARK_ORDER, formatProgressReport } from '../../benchmark/benchmark-progress.mjs';
import { PR_BENCHMARK_GROUPS } from '../../benchmark/benchmark-selection.mjs';
import { reportBenchmarkProgress, reportWouldGoBackwards, validateCheckpoint } from '../../benchmark/report-benchmark-progress.mjs';

const root=path.resolve(import.meta.dirname,'../../..');
const snapshot=JSON.parse(fs.readFileSync(path.join(root,'scripts/tests/benchmark/fixtures/benchmark-result.json'),'utf8'));
const identity={pr:7,runId:100,runAttempt:1,baseSha:'a'.repeat(40),headSha:'b'.repeat(40),baseRef:'develop',headRef:'feature'};
const rows=Object.values(PR_BENCHMARK_GROUPS).flatMap(name=>['CPU','GPU'].map(mode=>({...snapshot.results[0],name:`${name} [${mode}]`})));
const payload=(count=1,factor=1)=>({metadata:{...snapshot.metadata,sampleCount:count,selection:'pr',simulationClock:'fixed',simulationDeltaTime:1/60},results:rows.map(row=>({...row,avgUpdateMs:row.avgUpdateMs*factor}))});
const checkpoint=stage=>({metadata:{...identity,stage,completedPasses:stage*2,selection:'pr',simulationClock:'fixed'},base:payload(stage),head:payload(stage,2)});

test('checkpoints execute ABBAAB once and reuse cumulative samples through the original median/comparison scripts',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rzmps-progress-test-'));
  const measurements=[];
  const stages=[];
  fs.writeFileSync(path.join(directory,'metadata.json'),JSON.stringify(identity));
  const run=(script,args)=>{
    if(script.endsWith('benchmark-rzmps.mjs')){
      const output=args[args.indexOf('--output')+1];
      const sample=path.basename(output,'.json'); measurements.push(sample);
      assert.equal(args[args.indexOf('--selection')+1],'pr');
      assert.equal(args[args.indexOf('--simulation-clock')+1],'fixed');
      const factor={a:1,b:100,c:2}[sample.at(-1)]*(sample.startsWith('head')?2:1);
      fs.writeFileSync(output,JSON.stringify(payload(1,factor)));
    } else execFileSync(process.execPath,[script,...args],{stdio:'pipe'});
  };
  try{
    for(let stage=1;stage<=3;stage++){
      const output=runBenchmarkStage({stage,directory,run});stages.push(output);
      const base=JSON.parse(fs.readFileSync(path.join(output,'base.json')));
      const head=JSON.parse(fs.readFileSync(path.join(output,'head.json')));
      assert.equal(base.metadata.sampleCount,stage);assert.equal(head.metadata.sampleCount,stage);
      const factor=[1,50.5,2][stage-1];
      assert.equal(base.results[0].avgUpdateMs,snapshot.results[0].avgUpdateMs*factor);
      const comparison=JSON.parse(fs.readFileSync(path.join(output,'comparison.json')));
      assert.equal(comparison.overall.avgUpdateMs.percentChange,100);
      const markdown=fs.readFileSync(path.join(output,'comparison.md'),'utf8');
      assert.match(markdown,new RegExp(`Measurements:\\*\\* ${stage*2}/6`));
      assert.match(markdown,new RegExp(['Preliminary','Intermediate','Final'][stage-1]));
    }
    assert.deepEqual(measurements,BENCHMARK_ORDER);
    assert.equal(JSON.parse(fs.readFileSync(path.join(stages[0],'base.json'))).metadata.sampleCount,1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'base.json'))).metadata.sampleCount,3);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

function apiFixture(states,{existing,failCreateAfterSaving=false,wrongIdentity=false}={}){
  let index=0,created=0,updated=0,failedOnce=false;
  const comments=existing?[{id:1,user:{type:'Bot'},body:existing}]:[];
  const bodies=[];const warnings=[];
  const run={id:100,run_attempt:1,name:'PR Benchmarks',event:'pull_request',head_sha:identity.headSha,
    head_repository:{full_name:'owner/repo'},pull_requests:[{number:7}],html_url:'https://github.com/owner/repo/actions/runs/100'};
  const pr={number:7,state:'open',base:{sha:identity.baseSha,ref:'develop'},head:{sha:identity.headSha,ref:'feature',repo:{full_name:'owner/repo'}}};
  const listArtifacts=()=>{},listComments=()=>{};
  const github={rest:{actions:{getWorkflowRun:async()=>({data:{...run,...states[Math.min(index,states.length-1)]}}),
    listWorkflowRunArtifacts:listArtifacts},pulls:{get:async()=>({data:pr})},issues:{listComments,
    createComment:async({body})=>{created++;comments.push({id:1,user:{type:'Bot'},body});bodies.push(body);
      if(failCreateAfterSaving&&!failedOnce){failedOnce=true;throw new Error('API response lost after create');}},
    updateComment:async({body})=>{updated++;comments[0].body=body;bodies.push(body);}}},
    paginate:async method=>method===listComments?comments:[{id:states[Math.min(index,states.length-1)].stage??1,
      name:`benchmark-stage-1-${states[Math.min(index,states.length-1)].stage??1}`}],};
  return{github,run,pr,bodies,warnings,counts:()=>({created,updated}),
    options:{github,context:{repo:{owner:'owner',repo:'repo'},payload:{workflow_run:run}},core:{info(){},warning(message){warnings.push(message);}},
      sleep:async()=>{index++;},maxPolls:8,
      download:async(_github,_repo,artifact)=>{const value=checkpoint(artifact.id);if(wrongIdentity)value.metadata.headSha='c'.repeat(40);return value;},
      compare:value=>`<!-- rzmps-benchmark-report -->\n\n## 📊 Benchmark comparison\n\n| Case | Avg Update |\n| test | ${value.base.metadata.sampleCount} |\n`},};
}

test('AB, ABBA and ABBAAB progressively create and update one comment',async()=>{
  const fixture=apiFixture([{status:'in_progress',stage:1},{status:'in_progress',stage:2},{status:'completed',conclusion:'success',stage:3}]);
  await reportBenchmarkProgress(fixture.options);
  assert.deepEqual(fixture.counts(),{created:1,updated:2});
  for(let index=0;index<3;index++)assert.match(fixture.bodies[index],new RegExp(`${(index+1)*2}/6`));
  assert.match(fixture.bodies[0],/Preliminary/);assert.match(fixture.bodies[1],/Intermediate/);assert.match(fixture.bodies[2],/Final/);
  assert.match(fixture.bodies[0],/not a final regression determination/);
  assert.match(fixture.bodies[2],/Workflow logs and detailed results/);
});

test('reruns replace previous results without duplicating comments and older reports cannot move backwards',async()=>{
  const old=formatProgressReport('## 📊 Benchmark comparison\n', {...checkpoint(3).metadata,runId:99});
  const fixture=apiFixture([{status:'completed',conclusion:'success',stage:3}],{existing:`<!-- rzmps-benchmark-report -->\n${old}`});
  await reportBenchmarkProgress(fixture.options);
  assert.deepEqual(fixture.counts(),{created:0,updated:1});
  assert.equal(reportWouldGoBackwards('<!-- rzmps-benchmark-run:101:1:1 -->',fixture.run,3),true);
  assert.equal(reportWouldGoBackwards('<!-- rzmps-benchmark-run:100:2:1 -->',fixture.run,3),true);
  assert.equal(reportWouldGoBackwards('<!-- rzmps-benchmark-run:100:1:3 -->',fixture.run,2),true);
});

test('failed workflows keep the latest pair visible and mark it interrupted',async()=>{
  const fixture=apiFixture([{status:'in_progress',stage:1},{status:'completed',conclusion:'failure',stage:1}]);
  await reportBenchmarkProgress(fixture.options);
  assert.deepEqual(fixture.counts(),{created:1,updated:1});
  assert.match(fixture.bodies.at(-1),/Interrupted — incomplete/);
  assert.match(fixture.bodies.at(-1),/2\/6/);
  assert.match(fixture.bodies.at(-1),/\| test \| 1 \|/);
});

test('an API response lost after creating the comment is retried without a duplicate',async()=>{
  const fixture=apiFixture([{status:'completed',conclusion:'success',stage:3}],{failCreateAfterSaving:true});
  await reportBenchmarkProgress(fixture.options);
  assert.equal(fixture.counts().created,1);assert.equal(fixture.counts().updated,0);assert.equal(fixture.warnings.length,1);
});

test('fork artifacts are checked against live PR/repository/run identity before any write',async()=>{
  const fixture=apiFixture([{status:'completed',conclusion:'success',stage:3}],{wrongIdentity:true});
  await reportBenchmarkProgress(fixture.options);
  assert.deepEqual(fixture.counts(),{created:0,updated:0});
  const value=checkpoint(1);
  assert.equal(validateCheckpoint(value,fixture.run,1,fixture.pr),true);
  assert.equal(validateCheckpoint(value,fixture.run,1,{...fixture.pr,state:'closed'}),false);
  assert.equal(validateCheckpoint(value,fixture.run,1,{...fixture.pr,head:{...fixture.pr.head,repo:{full_name:'someone/else'}}}),false);
  value.metadata.runAttempt=2;
  assert.throws(()=>validateCheckpoint(value,fixture.run,1,fixture.pr),/identity/);
});

test('workflow keeps one read-only execution job, manual full coverage and an isolated trusted observer',()=>{
  const execution=parse(fs.readFileSync(path.join(root,'.github/workflows/benchmark.yml'),'utf8'));
  const reporting=parse(fs.readFileSync(path.join(root,'.github/workflows/benchmark-comment.yml'),'utf8'));
  assert.deepEqual(execution.permissions,{contents:'read'});
  assert.equal(Object.keys(execution.jobs).length,1);
  assert.ok(execution.on.workflow_dispatch.inputs.selection.options.includes('full'));
  assert.match(execution.jobs.benchmark.env.BENCHMARK_SELECTION,/benchmark:full/);
  const checkpoints=execution.jobs.benchmark.steps.filter(step=>step.name?.includes('checkpoint'));
  assert.equal(checkpoints.length,3);
  checkpoints.forEach((step,index)=>assert.equal(step.with.name,`benchmark-stage-\${{ github.run_attempt }}-${index+1}`));
  assert.deepEqual(reporting.on.workflow_run.types,['in_progress','completed']);
  assert.equal(reporting.permissions['pull-requests'],'write');
  assert.equal(reporting.jobs.comment.steps[0].with.ref,'${{ github.event.repository.default_branch }}');
  assert.equal(reporting.jobs.comment.steps.some(step=>step.run?.includes('npm ci')),false);
});
