import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { Emitter, EmissionShape, FLIPSimulation, Module, ParticleSystem } from '@rzmps/rzmps';

const renderer = new WebGPURenderer();
renderer.setSize(64, 64);
document.body.append(renderer.domElement);
await renderer.init();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.z = 8;
const alive = async system => (await system.selectiveReadback(128, ['position', 'velocity']))
  .filter(({ particle }) => particle.alive).map(({ particle }) => ({
    position: particle.position.toArray(), velocity: particle.velocity.toArray(),
  }));

window.runPredicateCase = async (mode, kind = 'spray') => {
  const child = new ParticleSystem({ gpuProcessing: true, renderers: [], maxParticles: 128,
    duration: 0.05, looping: false, emitters: [new Emitter({ rate: 0, radialSpeed: 0,
      source: EmissionShape.Sphere(1e-6),
      bursts: [{ time: 0, count: 1 }], initialValues: { lifetime: 10, velocity: new THREE.Vector3() } })],
  });
  const parent = new ParticleSystem({ gpuProcessing: true, renderers: [], maxParticles: 16,
    duration: 1, looping: false,
    emitters: [[0, 0, 2], [0, 0.05, 2], [2, 0, 2], [-2, 0, 0.1]].map(([x, y, speed]) =>
      new Emitter({ source: EmissionShape.Sphere(1e-6), radialSpeed: 0,
        rate: 0, bursts: [{ time: 0, count: 1 }], initialValues: { position: new THREE.Vector3(x, y, 0),
          lifetime: 2, velocity: new THREE.Vector3(speed, 0, 0), scale: 0.1 } })),
    // Spawn predicates must see velocity captured before this modifier, not live values after it.
    modules: mode === 'spawn' ? [new Module(Module.CPU_UNSUPPORTED, {
      modifyGPU: particle => { particle.velocity.assign(0); },
    })] : [],
  });
  const shouldEmitGPU = kind === 'age' ? FLIPSimulation.SprayCondition({ minimumAge: 1,
    minimumSpeed: 0, maximumNeighbors: null }) : kind.startsWith('spray') ? FLIPSimulation.SprayCondition({
    minimumAge: 0,
    minimumSpeed: 1, maximumNeighbors: mode === 'spawn' && kind === 'spray' ? null : 0 })
    : particle => particle.position.x.lessThan(0);
  parent.addSubSystem(child, { shouldEmit: () => { throw new Error('CPU predicate must not run on GPU'); },
    shouldEmitGPU, emitContinuous: mode === 'continuous', emitOnSpawn: mode === 'spawn',
    inheritVelocity: 1, inheritLifetime: 0 });
  scene.add(parent);
  await renderer.renderAsync(scene, camera);
  parent.advanceFrames(2, 1 / 60);
  const result = { parentGPU: parent.isGPUProcessingActive, childGPU: child.isGPUProcessingActive,
    supported: parent.getGPUEmissionSupport().supported, children: await alive(child) };
  const options = parent.subSystems.get(child);
  options.shouldEmit = false;
  child.clearParticles(false);
  parent.advanceFrames(2, 1 / 60);
  result.disabled = (await alive(child)).length;
  options.shouldEmit = true;
  const select = threshold => particle => particle.position.x.lessThan(threshold);
  options.shouldEmitGPU = select(-1);
  child.clearParticles(false);
  parent.advanceFrames(2, 1 / 60);
  result.replaced = await alive(child);
  options.shouldEmitGPU = select(1);
  child.clearParticles(false);
  parent.advanceFrames(2, 1 / 60);
  result.sameSourceClosure = await alive(child);
  parent.destroy();
  parent.removeFromParent();
  return result;
};
window.ready = true;
