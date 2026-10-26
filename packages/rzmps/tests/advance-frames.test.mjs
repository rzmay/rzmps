import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ParticleSystem, Emitter, Module, Particle, EmissionShape } from '../build/index.mjs';
const pointSource=()=>{ const source=EmissionShape.Sphere(); source.getPoint=()=>({position:new THREE.Vector3(),normal:new THREE.Vector3(0,1,0)}); return source; };
const make=()=>new ParticleSystem({emitters:new Emitter({source:pointSource(),rate:0,radialSpeed:0,bursts:[{time:0,count:1}],initialValues:{lifetime:5,velocity:new THREE.Vector3(2,0,0)}}),renderers:[],modules:new Module((p,dt)=>{p.velocity.y+=dt;}),gravityModifier:0});
const fixed=make();
fixed.advanceFrames(10,0.1);
assert.equal(fixed.particles.length,1);
assert.ok(Math.abs(fixed.particles[0].position.x-2)<1e-9);
assert.ok(Math.abs(fixed.particles[0].velocity.y-1)<1e-9);
// Wall-clock update and fixed advancement must share emission, movement and modifier semantics.
const clock=make();const previousNow=Date.now;let now=100000;
try {Date.now=()=>now;clock.lastFrame=now;for(let i=0;i<10;i++){now+=100;clock.update();}}
finally {Date.now=previousNow;}
assert.deepEqual(clock.particles[0].position.toArray(),fixed.particles[0].position.toArray());
assert.equal(fixed.playing,true);
fixed.pause();const position=fixed.particles[0].position.clone();fixed.advanceFrames(10);assert.ok(fixed.particles[0].position.equals(position));assert.equal(fixed.paused,true);
for(const args of [[-1],[1.5],[Infinity],[1,0],[1,NaN]])assert.throws(()=>fixed.advanceFrames(...args),RangeError);
const scaled=make();scaled.simulationSpeed=2;scaled.advanceFrames(5,0.1);assert.ok(Math.abs(scaled.particles[0].position.x-2)<1e-9);
const parent=new ParticleSystem({emitters:new Emitter({source:pointSource(),rate:0,radialSpeed:0,bursts:[{time:0,count:1}],initialValues:{lifetime:0.2}}),renderers:[]});
const child=new ParticleSystem({emitters:new Emitter({source:pointSource(),rate:0,radialSpeed:0,bursts:[{time:0,count:3}],initialValues:{lifetime:1}}),renderers:[]});
parent.addSubSystem(child,{emitContinuous:false,emitOnDeath:true,inheritLifetime:0,inheritScale:0});
parent.advanceFrames(5,0.1);assert.equal(child.particles.length,3);
const childPosition=child.particles[0].position.clone();child.advanceFrames(10);assert.ok(child.particles[0].position.equals(childPosition));
const dying=new ParticleSystem({duration:0.1,looping:false,emitters:[],renderers:[]});dying.particles.push(new Particle({lifetime:0.15}));dying.advanceFrames(5,0.1);assert.equal(dying.ended,true);assert.equal(dying.particles.length,0);
const stopped=make();stopped.advanceFrames(1,0.1);stopped.stop(false);const old=stopped.particles[0].position.x;stopped.advanceFrames(1,0.1);assert.ok(stopped.particles[0].position.x>old);assert.equal(stopped.playing,false);
// Prewarm and explicit stepping share the same core path without requiring a renderer.
const warmed=make();warmed.duration=1;warmed.prewarm=true;warmed.prewarmFPS=10;warmed.start();assert.ok(Math.abs(warmed.particles[0].position.x-2)<1e-8);
// User callbacks can throw; temporary timing/reflection settings still must be restored.
const broken=new ParticleSystem({emitters:[],renderers:[],modules:new Module(()=>{throw new Error('callback failure');}),useLiveCubemap:true});
broken.particles.push(new Particle({lifetime:5}));
const previousDelta=broken.deltaTime;
assert.throws(()=>broken.advanceFrames(1,0.25),/callback failure/);
assert.equal(broken.deltaTime,previousDelta);
broken.prewarm=true;
assert.throws(()=>broken.start(),/callback failure/);
assert.equal(broken.useLiveCubemap,true);
assert.equal(broken.deltaTime,previousDelta);
for(const system of [fixed,clock,scaled,parent,dying,stopped,warmed,broken])system.destroy();
console.log('Fixed-step advancement, clock parity, pause, stop, lifecycle, subsystems, and prewarm passed.');
