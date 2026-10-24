import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Module, Particle, ParticleSystem, Renderer, CompensationMode } from '../build/index.mjs';

const population = Number(process.env.RZMPS_BENCH_PARTICLES ?? 10000);
const frames = Number(process.env.RZMPS_BENCH_FRAMES ?? 60);
class CountRenderer extends Renderer {
  instances = 0;
  setup() {}
  _update(particles) { this.instances = particles.length; }
  clear() {}
  destroy() {}
}
function run(quality, compensate, children = 0, churn = false) {
  const roots = Math.floor(population / (1 + children));
  let visits = 0;
  const view = new CountRenderer({ children: { count: children, radius: 1 }, compensation: compensate ? CompensationMode.Children : CompensationMode.None });
  const system = new ParticleSystem({ gpuProcessing: false, gravityModifier: 0, emitters: [], renderers: view,
    lod: quality === 1 ? undefined : { distance: 1, quality, maxLevel: 1 },
    modules: new Module(particle => {
      visits++;
      let value = particle.position.x;
      for (let i = 0; i < 20; i++) value = Math.sin(value + i * 0.01);
      particle.velocity.x = value;
    }),
  });
  const camera = new THREE.PerspectiveCamera(); camera.position.z = 10; system._camera = camera;
  for (let i = 0; i < roots; i++) {
    const p = new Particle({ lifetime: 10000, position: new THREE.Vector3(i % 50, Math.floor(i / 50) % 50, Math.floor(i / 2500)) });
    p.id = `bench-${i}`; p.lodPriority = (i + 0.5) / roots;
    system.particles.push(p);
  }
  const startup = performance.now();
  system.advanceFrames(2);
  const startupMilliseconds = performance.now() - startup;
  visits = 0;
  let treeRebuilds = 0;
  if (system.particleOctree) {
    const rebuild = system.particleOctree.rebuild.bind(system.particleOctree);
    system.particleOctree.rebuild = (...args) => { treeRebuilds++; return rebuild(...args); };
  }
  const start = performance.now();
  if (churn) for (let frame = 0; frame < frames; frame++) {
    const births = Math.max(1, Math.floor(system.particles.length * 0.01));
    for (let i = 0; i < births; i++) {
      const old = system.particles[i];
      old.alive = false;
      const next = new Particle({ lifetime: 10000, position: old.position });
      next.id = `born-${frame}-${i}`; next.lodPriority = 0;
      system.particles[i] = next;
    }
    system.advanceFrames(1);
  } else system.advanceFrames(frames);
  const elapsed = performance.now() - start;
  assert.equal(visits, system.particles.length * frames);
  assert.equal(system.particles.length, Math.round(roots * quality));
  if (compensate) assert.equal(view.instances, Math.round(roots * quality) * (1 + children) / quality);
  const result = { quality, compensation: compensate ? 'children' : 'none', simulated: system.particles.length,
    artisticChildren: children, replacesOnePercentPerStep: churn, treeRebuilds, startupMilliseconds,
    visual: view.instances, moduleVisits: visits, millisecondsPerStep: elapsed / frames };
  system.destroy(); return result;
}
// Record startup separately. Churn cases include new-particle allocation and spatial rebuilds every measured step.
run(0.5, false);
const results = [];
for (const compensate of [false, true]) for (const quality of [1, 0.5, 0.25]) {
  const samples = Array.from({ length: 3 }, () => run(quality, compensate));
  samples.sort((a, b) => a.millisecondsPerStep - b.millisecondsPerStep);
  results.push(samples[1]);
}
for (const [quality, compensate, children, churn] of [[1, false, 2, false], [1, false, 2, true], [0.5, true, 0, true]]) {
  const samples = Array.from({ length: 3 }, () => run(quality, compensate, children, churn));
  samples.sort((a, b) => a.millisecondsPerStep - b.millisecondsPerStep);
  results.push(samples[1]);
}
console.log(JSON.stringify({ population, frames, results }, null, 2));
