import fs from 'node:fs/promises';
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { DecalRenderer, Particle, ParticleSystem } from '../../../../packages/rzmps/build/index.mjs';

// CPU-only isolated contact queries against the actual demo receiver. No solver/render work is timed.
const scene = new THREE.Scene();
const model = new OBJLoader().parse(
  await fs.readFile('examples/assets/models/utah_teapot_quad_wide_spout.obj', 'utf8'),
);
model.scale.setScalar(0.76);
scene.add(model);
const view = new DecalRenderer(new THREE.MeshBasicMaterial(), {
  direction: DecalRenderer.Radial(6),
  maxDistance: 0.12,
});
const system = new ParticleSystem({ emitters: [], renderers: [view] });
scene.add(system);
scene.updateMatrixWorld(true);
const meshes = [];
model.traverse(object => {
  if (object instanceof THREE.Mesh) meshes.push(object);
});
const sources = Array.from({ length: 100 }, (_, i) => {
  const mesh = meshes[i % meshes.length];
  const position = mesh.geometry.getAttribute('position'),
    normal = mesh.geometry.getAttribute('normal');
  const index = (i * 1543) % position.count;
  const p = new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld);
  const n = new THREE.Vector3().fromBufferAttribute(normal, index).transformDirection(mesh.matrixWorld);
  return new Particle({ position: p.addScaledVector(n, 0.03), lifetime: 1 });
});
const results = [];
for (const mode of ['native', 'accelerated']) {
  for (const mesh of meshes) {
    if (mode === 'native')
      mesh.raycast = function (...args) {
        return THREE.Mesh.prototype.raycast.apply(this, args);
      };
    else delete mesh.raycast;
  }
  const first = performance.now();
  view.findHits(sources[0], sources[0].position, system);
  const firstQueryMs = performance.now() - first;
  const samples = [];
  for (let repeat = 0; repeat < 5; repeat++) {
    const start = performance.now();
    let hits = 0;
    for (const source of sources) hits += view.findHits(source, source.position, system).length;
    samples.push({ ms: performance.now() - start, hits });
  }
  results.push({
    mode,
    firstQueryMs,
    queries: 100,
    raysPerQuery: 6,
    medianMs: samples.map(sample => sample.ms).sort((a, b) => a - b)[2],
    samples,
  });
}
const result = {
  geometryTriangles: meshes.reduce(
    (sum, mesh) => sum + (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3,
    0,
  ),
  results,
};
await fs.writeFile(process.argv[2] ?? '/tmp/decal-projection.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
system.destroy();
model.traverse(object => object.geometry?.dispose());
