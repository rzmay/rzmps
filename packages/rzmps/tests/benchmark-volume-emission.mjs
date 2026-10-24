import * as THREE from 'three';
import { MeshSurfaceSampler } from 'three/examples/jsm/math/MeshSurfaceSampler.js';
import seedrandom from 'seedrandom';
import { EmissionShape, EmissionSource } from '../build/index.mjs';

const spawnCount = Number(process.env.RZMPS_VOLUME_BENCHMARK_SPAWNS ?? 10_000);
const repetitions = Number(process.env.RZMPS_VOLUME_BENCHMARK_REPETITIONS ?? 5);
const originalRandom = Math.random;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function withSeed(seed, callback) {
  Math.random = seedrandom(seed);
  try {
    return callback();
  } finally {
    Math.random = originalRandom;
  }
}

// Preserve the former CPU path, including its five parity attempts and
// per-spawn closest-vertex sort, to provide a reproducible legacy baseline.
function createLegacySampler(geometry) {
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const surfaceSampler = new MeshSurfaceSampler(mesh)
    .setRandomGenerator(() => Math.random())
    .build();
  const raycaster = new THREE.Raycaster();
  const rayDirection = new THREE.Vector3(1, 0.371, 0.529).normalize();
  const randomPoint = new THREE.Vector3();
  const surfaceNormal = new THREE.Vector3();

  return () => {
    const { min, max } = geometry.boundingBox;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      randomPoint.set(
        THREE.MathUtils.lerp(min.x, max.x, Math.random()),
        THREE.MathUtils.lerp(min.y, max.y, Math.random()),
        THREE.MathUtils.lerp(min.z, max.z, Math.random()),
      );
      raycaster.set(randomPoint, rayDirection);
      if (raycaster.intersectObject(mesh, false).length % 2 === 1) {
        const position = geometry.getAttribute('position');
        const vertices = Array.from({ length: position.count }, (_, index) => (
          new THREE.Vector3().fromBufferAttribute(position, index)
        ));
        vertices.sort((a, b) => randomPoint.distanceTo(a) - randomPoint.distanceTo(b));
        const closest = vertices.slice(0, 5);
        const normal = new THREE.Vector3();
        let weight = 0;
        closest.forEach((vertex) => {
          const distance = randomPoint.distanceTo(vertex);
          normal.addScaledVector(vertex, distance);
          weight += distance;
        });
        if (weight > 0) normal.divideScalar(weight);
        return randomPoint.x + normal.x;
      }
    }

    surfaceSampler.sample(randomPoint, surfaceNormal);
    return randomPoint.x + surfaceNormal.x;
  };
}

function measure(label, geometryFactory) {
  const legacyTimes = [];
  const bakedTimes = [];
  const bakeTimes = [];
  let checksum = 0;
  let resolvedSamples = 0;

  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const legacySample = createLegacySampler(geometryFactory());
    legacyTimes.push(withSeed(`${label}:legacy:${repetition}`, () => {
      const started = performance.now();
      for (let index = 0; index < spawnCount; index += 1) checksum += legacySample();
      return performance.now() - started;
    }));

    const shape = new EmissionShape({
      geometry: geometryFactory(),
      source: EmissionSource.Volume,
      volumeSamples: 'auto',
    });
    bakeTimes.push(withSeed(`${label}:bake:${repetition}`, () => {
      const started = performance.now();
      resolvedSamples = shape.getVolumeSamples().length;
      return performance.now() - started;
    }));
    bakedTimes.push(withSeed(`${label}:baked:${repetition}`, () => {
      const started = performance.now();
      for (let index = 0; index < spawnCount; index += 1) checksum += shape.getPoint().position.x;
      return performance.now() - started;
    }));
  }

  const legacyMs = median(legacyTimes);
  const bakedMs = median(bakedTimes);
  return {
    shape: label,
    spawns: spawnCount,
    resolvedSamples,
    legacyExactMs: legacyMs,
    bakeMs: median(bakeTimes),
    bakedSteadyMs: bakedMs,
    steadySpeedup: legacyMs / bakedMs,
    checksum,
  };
}

const results = [
  measure('sphere-32x16', () => new THREE.SphereGeometry(1, 32, 16)),
  measure('torus-32x64', () => new THREE.TorusGeometry(1, 0.3, 32, 64)),
];

console.log(`Volume emission benchmark (${repetitions} median runs, ${spawnCount.toLocaleString()} spawns)`);
results.forEach((result) => {
  console.log([
    result.shape,
    `${result.resolvedSamples} samples`,
    `legacy exact ${result.legacyExactMs.toFixed(2)}ms`,
    `bake ${result.bakeMs.toFixed(2)}ms`,
    `baked steady ${result.bakedSteadyMs.toFixed(2)}ms`,
    `${result.steadySpeedup.toFixed(1)}x steady speedup`,
  ].join(' | '));
});
console.log(JSON.stringify(results, null, 2));
