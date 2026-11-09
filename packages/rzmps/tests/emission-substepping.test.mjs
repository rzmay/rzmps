import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Emitter, Module, ParticleSystem, Particle, SpatialEffect, Renderer, EmissionShape } from '../build/index.mjs';

const near = (actual, expected, epsilon = 1e-8) => assert.ok(Math.abs(actual - expected) < epsilon,
  `${actual} != ${expected}`);
const systems = [];
const make = (options = {}, emission = {}) => {
  const shape=EmissionShape.Sphere();
  shape.getPoint=()=>({position:new THREE.Vector3(),normal:new THREE.Vector3(0,1,0)});
  const system = new ParticleSystem({ emitters: new Emitter({ source:shape, rate: 4, radialSpeed: 0,
    initialValues: { lifetime: 10, velocity: new THREE.Vector3(2, 0, 0) }, ...emission }),
  renderers: [], gravityModifier: 0, substep: false, ...options });
  systems.push(system);
  // Establish the existing emitter clock at zero without advancing time.
  system.deltaTime = 0;
  system._advanceSimulationStep();
  return system;
};
const samples = system => system.particles.map(p => [p.realtime / 1000, p.position.x]).sort((a,b) => a[0]-b[0]);
const compare = (a,b) => {
  const left=samples(a), right=samples(b);
  assert.equal(left.length, right.length);
  left.forEach((row,i) => row.forEach((value,j) => near(value,right[i][j])));
};

try {
  const callbacks = [];
  const single = make({ modules: new Module((p,dt) => {
    assert.ok(p.realtime >= 0 && p.time >= 0);
    callbacks.push(dt);
  }, { priority: -1, initializeParticle(p) { assert.equal(p.realtime, 0); assert.equal(p.time, 0); } }) });
  single.onSpawn(p => { assert.equal(p.realtime,0); assert.equal(p.time,0); });
  single.advanceFrames(1, 1);
  assert.deepEqual(samples(single), [[0,0],[0.25,0.5],[0.5,1],[0.75,1.5]]);
  assert.deepEqual(callbacks, [0.75,0.5,0.25,0]);
  const fractional = make({}, { rate: 3 });
  fractional.advanceFrames(5, 0.1);
  assert.equal(fractional.particles.length, 1);
  near(fractional.particles[0].realtime / 1000, 1/6);
  fractional.advanceFrames(5, 0.1);
  assert.equal(fractional.particles.length, 3);
  near(fractional.particles.at(-1).realtime, 0);

  const burst = make({ duration: 2 }, { rate:0, bursts:[{time:0.125,count:2},{time:0.375,count:1}] });
  burst.advanceFrames(1,1);
  assert.deepEqual(samples(burst), [[0.25,0.5],[0.75,1.5],[0.75,1.5]]);
  const expiring = make({}, { rate:4, initialValues:{ lifetime:0.3,velocity:new THREE.Vector3(2,0,0) } });
  expiring.advanceFrames(1,1);
  assert.deepEqual(samples(expiring), [[0,0],[0.25,0.5]]);

  // Every priority, including transient cache reconstruction, receives the same effective delta.
  const phases=[];
  const transient = make({modules:[-1,0,1].map(priority => new Module((p,dt) => {
    phases.push([priority,dt]); p.velocity.y += dt;
  },{priority}))});
  transient.advanceFrames(1,0.5);
  for(const priority of [-1,0,1]) assert.deepEqual(phases.filter(x=>x[0]===priority).map(x=>x[1]),[0.25,0]);
  transient.advanceFrames(1,0.25);
  near(transient.particles[0].position.y, 0.3125);

  class CounterRenderer extends Renderer { calls=0; setup(){} clear(){} destroy(){} _update(){this.calls++;} }
  const output = new CounterRenderer();
  const large=make({substep:true,substepDeltaTime:0.1,renderers:output});
  const small=make({substep:false});
  output.calls=0;
  large.advanceFrames(1,1); small.advanceFrames(10,0.1);
  compare(large,small);
  assert.equal(output.calls,1);
  const effects = () => new SpatialEffect((p,dt)=>{p.velocity.y+=dt;},{test:()=>true,priority:-1});
  const spatialLarge=make({substep:true,substepDeltaTime:0.1,spatialEffects:effects()});
  const spatialSmall=make({spatialEffects:effects()});
  spatialLarge.advanceFrames(1,1);spatialSmall.advanceFrames(10,0.1);
  spatialLarge.particles.forEach((p,i)=>near(p.position.y,spatialSmall.particles[i].position.y));

  const sourced=make({}, {rate:4,sources:{tags:['origin']}});
  const source=sourced.registerEmissionSource({tags:['origin'],transform:new THREE.Matrix4()});
  sourced.deltaTime=0;sourced._advanceSimulationStep();
  sourced.advanceFrames(1,1);
  assert.deepEqual(samples(sourced),samples(single));
  source.dispose();

  // Paused wall time never enters simulation, with or without display updates.
  const originalNow=Date.now;
  let now=100000;
  try {
    Date.now=()=>now;
    for(const callUpdates of [false,true]) {
      const paused=make();
      paused.lastFrame=now;
      paused.particles.push(new Particle({lifetime:20}));
      paused.pause();
      for(let i=0;i<5;i++){now+=1000;if(callUpdates)paused.update();}
      assert.equal(paused.particles[0].realtime,0);
      if(callUpdates)assert.equal(paused.lastFrame,now);
      paused.advanceFrames(5,1);assert.equal(paused.particles[0].realtime,0);
      paused.start(false);assert.equal(paused._elapsedTime,0);
      paused.update();assert.equal(paused.particles[0].realtime,0);
      now+=100;paused.update();near(paused.particles[0].realtime,100);
    }
    const clockLarge=make({substep:true,substepDeltaTime:0.1});
    const clockSmall=make({substep:false});
    clockLarge.lastFrame=clockSmall.lastFrame=now;
    for(let i=0;i<10;i++){now+=100;clockSmall.update();}
    clockLarge.update();compare(clockLarge,clockSmall);
  } finally {Date.now=originalNow;}

  for(const [lifetime, expected] of [[2,2],[[2,7],7],[new Set([2,4]),4],
    [()=>5,5],[[1,()=>9],9],[Infinity,null]]) {
    assert.equal(new Emitter({initialValues:{lifetime}}).getMaxLifetime(),expected);
  }
  const skipped=make({duration:100,substep:true,substepDeltaTime:0.1,maxCatchup:0.5},{rate:3});
  skipped.advanceFrames(1,2.1);
  assert.equal(skipped.particles.length,2);
  near(skipped._elapsedTime,2.1);
  near(skipped.particles[0].realtime/1000,2.1-5/3);
  near(skipped.particles[1].realtime/1000,0.1);
  skipped.advanceFrames(1,0.3);
  near(skipped.particles.at(-1).realtime/1000,2.4-7/3);

  const fast=make({duration:100,substep:true,substepDeltaTime:0.1,maxCatchup:0.5,simulationSpeed:2},{rate:3});
  fast.advanceFrames(1,1.05);near(fast._elapsedTime,2.1);
  assert.equal(fast.particles.length,2);
  near(fast.particles[0].realtime/1000,2.1-5/3);
  const retained=make({duration:100,substep:true,substepDeltaTime:0.1,maxCatchup:0.5},
    {rate:0,bursts:{time:0,count:1}});
  retained.advanceFrames(1,2.1);
  near(retained.particles[0].realtime,2100);
  near(retained.particles[0].position.x,1);
  const noCatchup=make({duration:100,substep:true,maxCatchup:0},{rate:4});
  noCatchup.advanceFrames(1,0.02);
  assert.equal(noCatchup.particles.length,0);
  near(noCatchup._elapsedTime,0.02);

  const skippedBurst=make({duration:100,substep:true,substepDeltaTime:0.1,maxCatchup:0.5},
    {rate:0,bursts:[{time:0.005,count:50},{time:0.018,count:2}]});
  skippedBurst.advanceFrames(1,2.1);
  assert.equal(skippedBurst.particles.length,2);
  skippedBurst.particles.forEach(p=>near(p.realtime/1000,0.3));
  const wrapped=make({duration:2,substep:true,substepDeltaTime:0.1,maxCatchup:0.5},
    {rate:0,bursts:[{time:0.1,count:50},{time:0.9,count:2}]});
  wrapped.advanceFrames(1,7.9);
  assert.equal(wrapped.particles.length,2);
  wrapped.particles.forEach(p=>near(p.realtime/1000,0.1));

  const distance=make({duration:100,substep:true,substepDeltaTime:0.1,maxCatchup:0.5},
    {rate:0,rateOverDistance:10});
  distance.position.x=100;
  distance.advanceFrames(1,2);
  assert.equal(distance.particles.length,0,'discarded displacement produces no distance credit');
  distance.position.x+=0.2;distance.advanceFrames(1,0.1);
  assert.equal(distance.particles.length,2);

  const automatic=make({duration:0.6,substep:true,substepDeltaTime:0.1},
    {rate:0,initialValues:{lifetime:t=>0.4+0.1*t}});
  let autoSteps=0;
  const autoAdvance=automatic._advanceSimulationStep.bind(automatic);
  automatic._advanceSimulationStep=(...args)=>{autoSteps++;return autoAdvance(...args);};
  automatic.advanceFrames(1,2);assert.equal(autoSteps,6,'duration exceeds sampled lifetime');
  automatic.duration=1;autoSteps=0;automatic.advanceFrames(1,2);assert.equal(autoSteps,10);
  automatic.emitters[0].initialValues.lifetime=()=>1.2;
  autoSteps=0;automatic.advanceFrames(1,2);assert.equal(autoSteps,12);
  automatic.emitters[0].initialValues.lifetime=1.5;
  autoSteps=0;automatic.advanceFrames(1,2);assert.equal(autoSteps,15);
  automatic.maxCatchup=0.2;autoSteps=0;automatic.advanceFrames(1,2);assert.equal(autoSteps,2);

  const bounded=make({substep:true,substepDeltaTime:0.01}, {initialValues:{lifetime:Infinity}});
  let steps=0;const advance=bounded._advanceSimulationStep.bind(bounded);
  bounded._advanceSimulationStep=(...args)=>{steps++;return advance(...args);};
  bounded.advanceFrames(1,1000000);
  assert.ok(steps<=240);assert.ok(bounded.particles.length<20);
  console.log('Distributed births, fractional timing, bursts, per-particle phases, substeps, sources, pause/restart and bounded catch-up passed.');
} finally {systems.forEach(system=>system.destroy());}
