import * as THREE from 'three';
import { If, float } from 'three/tsl';
import { Emitter, ParticleSystem, Module, Renderer, SpatialEffect, EmissionShape, Collision,
  ThreeCollisionBackend, ThreeGPUCollisionBackend } from '@rzmps/rzmps';
import { createWebGPURenderer } from '../../apps/demo/src/rendering/createWebGPURenderer.js';

const near=(a,b,label)=>{if(!Number.isFinite(a)||!Number.isFinite(b)||Math.abs(a-b)>(label==='realtime'?0.002:0.0001))throw new Error(`${label}: ${a} != ${b}`);};
const check=(condition,message)=>{if(!condition)throw new Error(message);};
class Output extends Renderer {
  calls=0; setup(){} clear(){} destroy(){} _update(){} _updateGPU(){this.calls++;}
}
async function verify() {
  const renderer=await createWebGPURenderer({antialias:false,forceWebGL:false});
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(50,1,0.1,100);
  camera.position.z=10;renderer.setSize(64,64);
  document.body.append(renderer.domElement);
  const systems=[];
  const make=(gpu,options={},emission={})=>{
    // Degenerate box vertices provide the same fixed origin on both backends.
    const source=EmissionShape.Box({source:'vertices'},0,0,0);
    const normals=source.geometry.getAttribute('normal');
    for(let i=0;i<normals.count;i++)normals.setXYZ(i,0,1,0);
    normals.needsUpdate=true;
    const system=new ParticleSystem({gpuProcessing:gpu,gravityModifier:0,duration:10,
      substep:false,renderers:new Output(),
      emitters:new Emitter({source,rate:4,radialSpeed:0,initialValues:{lifetime:10,
        velocity:new THREE.Vector3(2,0,0)},...emission}),...options});
    systems.push(system);scene.add(system);renderer.render(scene,camera);
    system.deltaTime=0;system._advanceSimulationStep();
    return system;
  };
  const particles=async system=>{
    await renderer.backend.device.queue.onSubmittedWorkDone();
    return (system.gpuProcessing?(await system.selectiveReadback(256)).filter(s=>s.valid).map(s=>s.particle):system.particles)
      .sort((a,b)=>a.realtime-b.realtime);
  };
  const compare=async (gpu,cpu)=>{
    const actual=await particles(gpu),expected=await particles(cpu);
    // Native readback is permanent simulation state; CPU display particles still
    // include transient values until their next restore.
    expected.forEach(p=>p.restore());
    check(gpu.isGPUProcessingActive,'GPU simulation must be active');
    check(actual.length===expected.length,`population ${actual.length} != ${expected.length}`);
    for(let i=0;i<actual.length;i++){
      for(const field of ['realtime','time','lifetime','alpha'])near(actual[i][field],expected[i][field],field);
      for(const field of ['position','velocity','rotation','scale']){
        for(const axis of ['x','y','z'])near(actual[i][field][axis],expected[i][field][axis],`${field}.${axis}`);
      }
    }
    return actual;
  };
  const advance=(system,frames,dt)=>system.advanceFrames(frames,dt);
  const results=[];
  try {
    for(const [name,frames,dt,emission] of [
      ['large',1,1,{}],['fractional',10,0.1,{rate:3}],
      ['bursts',1,1,{rate:0,bursts:[{time:0.025,count:2},{time:0.075,count:1}]}],
      ['expiration',1,1,{initialValues:{lifetime:0.3,velocity:new THREE.Vector3(2,0,0)}}],
    ]) {
      const gpu=make(true,{},emission),cpu=make(false,{},emission);
      advance(gpu,frames,dt);advance(cpu,frames,dt);
      const sample=await compare(gpu,cpu);results.push([name,sample.length]);
      if(name==='large')sample.forEach((p,i)=>near(p.realtime,i*250,'distributed age'));
    }

    const module=()=>new Module((p,dt)=>{check(p.realtime>=0&&p.time>=0,'public age');p.velocity.y+=dt;}, {
      priority:-1, initializeParticle(p){near(p.realtime,0,'CPU birth age');},
      initializeParticleGPU(p){p.scale.x.assign(p.realtime.add(1));},
      modifyGPU(p,dt){If(p.realtime.lessThan(0),()=>p.alpha.assign(0));p.velocity.y.addAssign(dt);},
    });
    const transient=()=>new Module((p,dt)=>{p.velocity.z+=dt;},{priority:0,
      modifyGPU(p,dt){p.velocity.z.addAssign(dt);}});
    const spatial=()=>new SpatialEffect((p,dt)=>{p.velocity.x+=dt;},{test:()=>true,
      priority:-1,testGPU:()=>float(1),modifyGPU:(p,dt)=>{p.velocity.x.addAssign(dt);}});
    const gpu=make(true,{modules:[module(),transient()],spatialEffects:spatial()}),
      cpu=make(false,{modules:[module(),transient()],spatialEffects:spatial()});
    advance(gpu,1,0.7);advance(cpu,1,0.7);await compare(gpu,cpu);
    advance(gpu,1,0.2);advance(cpu,1,0.2);await compare(gpu,cpu);results.push(['callbacks',true]);

    const large=make(true,{substep:true,substepDeltaTime:0.1,modules:module()});
    const small=make(true,{modules:module()});
    const cpuSmall=make(false,{modules:module()});
    large.renderers[0].calls=0;
    advance(large,1,1);advance(small,10,0.1);advance(cpuSmall,10,0.1);
    await compare(large,cpuSmall);await compare(small,cpuSmall);
    check(large.renderers[0].calls===1,'Only final substep hands particles to renderer');
    results.push(['substeps',true]);

    // A CPU registered source stages packed births into the same GPU age path.
    const sourceGPU=make(true,{}, {sources:{tags:['origin']}}),sourceCPU=make(false,{}, {sources:{tags:['origin']}});
    for(const system of [sourceGPU,sourceCPU]){
      system.registerEmissionSource({tags:['origin'],transform:new THREE.Matrix4()});
      system.deltaTime=0;system._advanceSimulationStep();advance(system,1,1);
    }
    await compare(sourceGPU,sourceCPU);results.push(['registered sources',true]);

    // Native GPU source queues resolve request-relative birth offsets per parent.
    const children=[];
    for(const isGPU of [true,false]){
      const parent=make(isGPU,{}, {rate:0,bursts:{time:0,count:1},initialValues:{lifetime:10}});
      const child=make(isGPU,{}, {rate:4});
      parent.addSubSystem(child,{emitContinuous:true,inheritLifetime:0,inheritScale:0,inheritVelocity:0});
      child.particles=[];child._clearEmitterInstances();
      parent.deltaTime=0;parent._advanceSimulationStep();advance(parent,1,1);children.push(child);
    }
    await compare(children[0],children[1]);results.push(['native source queue',true]);
    // Native spawn-triggered event runs retain scheduled burst times rather than
    // spreading the event's burst population across the entire frame.
    const eventChildren=[];
    for(const isGPU of [true,false]){
      const parent=make(isGPU,{}, {rate:0,bursts:{time:0,count:1},initialValues:{lifetime:10}});
      const child=make(isGPU,{}, {rate:0,bursts:[{time:0,count:2},{time:0.05,count:1}]});
      parent.addSubSystem(child,{emitContinuous:false,emitOnSpawn:true,inheritLifetime:0,
        inheritScale:0,inheritVelocity:0});
      parent.start(false);parent.deltaTime=0;parent._advanceSimulationStep();
      advance(parent,1,1);eventChildren.push(child);
    }
    await compare(eventChildren[0],eventChildren[1]);results.push(['event runs',true]);

    // Compare repeated collision steps on each backend; contact geometry can resolve
    // slightly differently between the CPU octree and the GPU BVH.
    const floor=new THREE.Mesh(new THREE.BoxGeometry(20,0.2,20),new THREE.MeshBasicMaterial());
    floor.position.y=-1;scene.add(floor);floor.updateMatrixWorld();
    for(const isGPU of [true,false]){
      const colliding=()=>new Collision({backend:isGPU
        ? new ThreeGPUCollisionBackend({staticObjects:[floor]})
        : new ThreeCollisionBackend({staticObjects:[floor]})});
      const emission={rate:4,initialValues:{lifetime:10,scale:0.05,velocity:new THREE.Vector3(0,-2,0)}};
      const large=make(isGPU,{substep:true,substepDeltaTime:0.05,modules:colliding()},emission);
      const small=make(isGPU,{modules:colliding()},emission);
      advance(large,1,1);advance(small,20,0.05);
      const a=await particles(large),b=await particles(small);
      check(a.length===b.length,'collision population');
      a.forEach((p,i)=>{near(p.position.y,b[i].position.y,'collision position');
        near(p.velocity.y,b[i].velocity.y,'collision velocity');});
      check(a.some(p=>p.velocity.y>0),`Collision must bounce a particle: gpu=${isGPU} ${JSON.stringify(a.map(p=>[p.position.y,p.velocity.y]))}`);
    }
    results.push(['collisions',true]);

    for(const [name,options,emission] of [
      ['skipped phase',{duration:100,maxCatchup:0.5},{rate:3}],
      ['skipped bursts',{duration:100,maxCatchup:0.5},{rate:0,
        bursts:[{time:0.005,count:50},{time:0.018,count:2}]}],
      ['skipped cycles',{duration:2,maxCatchup:0.5},{rate:0,
        bursts:[{time:0.1,count:50},{time:0.9,count:2}]}],
      ['skipped registered source',{duration:100,maxCatchup:0.5},
        {rate:3,sources:{tags:['catchup']}}],
    ]){
      const gpu=make(true,{substep:true,substepDeltaTime:0.1,...options},emission);
      const cpu=make(false,{substep:true,substepDeltaTime:0.1,...options},emission);
      for(const system of [gpu,cpu]){
        if(emission.sources){
          system.registerEmissionSource({tags:['catchup'],transform:new THREE.Matrix4()});
          system.deltaTime=0;system._advanceSimulationStep();
        }
        advance(system,1,name==='skipped cycles'?7.9:2.1);
      }
      const sample=await compare(gpu,cpu);
      check(sample.length===2,`${name}: only retained births survive`);
      results.push([name,true]);
    }

    for(const eventDriven of [false,true]){
      const children=[];
      for(const isGPU of [true,false]){
        const parent=make(isGPU,{duration:100,substep:true,substepDeltaTime:0.1,maxCatchup:0.5},
          {rate:0,bursts:{time:0,count:1},initialValues:{lifetime:100}});
        const child=make(isGPU,{duration:eventDriven?10:2}, {rate:0,bursts:eventDriven
          ? [{time:0.005,count:50},{time:0.78,count:2}]
          : [{time:0.1,count:50},{time:0.9,count:2}]});
        parent.addSubSystem(child,{emitContinuous:!eventDriven,emitOnSpawn:eventDriven,
          inheritLifetime:0,inheritScale:0,inheritVelocity:0});
        if(eventDriven)parent.start(false);
        parent.deltaTime=0;parent._advanceSimulationStep();
        advance(parent,1,7.9);children.push(child);
      }
      const sample=await compare(children[0],children[1]);
      check(sample.length===2,`skipped ${eventDriven?'event':'native source'} births`);
      results.push([eventDriven?'skipped event runs':'skipped native source',true]);
    }

    const oldGPU=make(true,{duration:100,substep:true,substepDeltaTime:0.1,maxCatchup:0.5},
      {rate:0,bursts:{time:0,count:1}});
    const oldCPU=make(false,{duration:100,substep:true,substepDeltaTime:0.1,maxCatchup:0.5},
      {rate:0,bursts:{time:0,count:1}});
    advance(oldGPU,1,2.1);advance(oldCPU,1,2.1);
    const old=await compare(oldGPU,oldCPU);
    near(old[0].realtime,2100,'realtime');
    near(old[0].position.x,1,'retained motion');
    results.push(['existing age across discarded time',true]);

    const originalNow=Date.now;let now=100000;
    try {
      Date.now=()=>now;
      for(const updates of [true,false]){
        const paused=make(true);advance(paused,1,1);
        const before=await particles(paused);paused.lastFrame=now;paused.pause();
        for(let i=0;i<5;i++){now+=1000;if(updates)paused.update();}
        advance(paused,5,1);
        const frozen=await particles(paused);
        frozen.forEach((p,i)=>near(p.realtime,before[i].realtime,'paused age'));
        paused.start(false);paused.update();
        const restarted=await particles(paused);
        restarted.forEach((p,i)=>near(p.realtime,before[i].realtime,'restart age'));
      }
    } finally {Date.now=originalNow;}
    results.push(['pause and restart',true]);
    return results;
  } finally {systems.forEach(system=>system.destroy());renderer.dispose();}
}
verify().then(results=>{window.emissionTimingResult={results};},error=>{
  window.emissionTimingResult={error:error.stack??String(error)};
});
