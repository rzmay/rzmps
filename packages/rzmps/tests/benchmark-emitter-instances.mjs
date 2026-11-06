import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';

const { values } = parseArgs({ options: {
  baseline: { type: 'string' }, output: { type: 'string' },
  repetitions: { type: 'string', default: '5' }, counts: { type: 'string', default: '8,256,2048' },
} });
const repetitions = Number(values.repetitions);
const counts = values.counts.split(',').map(Number);
if (!Number.isInteger(repetitions) || repetitions < 1 || counts.some(count => !Number.isInteger(count) || count < 1)) {
  throw new Error('Repetitions and source counts must be positive integers.');
}
if (!global.gc) throw new Error('Run this benchmark with node --expose-gc.');
const libraries = { after: await import('../build/index.mjs') };
if (values.baseline) libraries.before = await import(pathToFileURL(resolve(values.baseline)).href);

function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

function measure(library, kind, count) {
  const { ParticleSystem, Emitter, EmissionShape } = library;
  global.gc();
  const initialHeap = process.memoryUsage().heapUsed;
  const shape = new EmissionShape({ geometry: new THREE.PlaneGeometry(1, 1), source: 'vertices' });
  const point = { position: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0) };
  shape.getPoint = () => point;
  const emitter = new Emitter({
    source: shape, sources: { tags: ['origin'] }, rate: kind === 'live' ? 12 : 0,
    bursts: kind === 'events' ? [{ time: 0, count: 1 }, { time: 0.5, count: 1 }] : [],
    onEvent: kind === 'events' ? { pulse: true } : undefined,
    emitContinuous: kind === 'live', radialSpeed: 0, initialValues: { lifetime: 0.2 },
  });
  const system = new ParticleSystem({ emitters: [emitter], renderers: [], gravityModifier: 0,
    duration: 0.4, looping: true, maxParticles: count * 8 });
  const sources = Array.from({ length: count }, () => system.registerEmissionSource({ tags: ['origin'] }));
  // Count births without adding event subscriptions that would change the measured workload.
  let births = 0;
  const notify = system._notifySpawn.bind(system);
  system._notifySpawn = particle => { births++; notify(particle); };
  const step = frame => {
    if (kind === 'events' && frame % 30 === 0) {
      for (const source of sources) source.emitEvent('pulse', { strength: 1 });
    }
    system.advanceFrames(1, 1 / 60);
  };
  try {
    for (let frame = 0; frame < 60; frame++) step(frame);
    global.gc();
    const retainedHeapBytes = process.memoryUsage().heapUsed - initialHeap;
    const samples = [];
    const initialTimedHeap = process.memoryUsage().heapUsed;
    births = 0;
    for (let frame = 0; frame < 90; frame++) {
      const start = performance.now();
      step(frame);
      samples.push(performance.now() - start);
    }
    return {
      avgUpdateMs: samples.reduce((sum, time) => sum + time, 0) / samples.length,
      births, retainedHeapBytes,
      // Net heap growth includes automatic GC; it is not a count of allocated bytes.
      timedHeapGrowthBytes: process.memoryUsage().heapUsed - initialTimedHeap,
    };
  } finally { system.destroy(); }
}

const samples = [];
for (let round = 0; round < repetitions; round++) {
  const order = round % 2 ? ['after', 'before'] : ['before', 'after'];
  for (const revision of order.filter(name => libraries[name])) {
    for (const kind of ['live', 'events']) for (const count of counts) {
      samples.push({ revision, round, kind, count, ...measure(libraries[revision], kind, count) });
    }
  }
}
const summary = [];
for (const kind of ['live', 'events']) for (const count of counts) {
  const revisions = Object.fromEntries(Object.keys(libraries).map(revision => {
    const rows = samples.filter(row => row.kind === kind && row.count === count && row.revision === revision);
    return [revision, Object.fromEntries(['avgUpdateMs', 'births', 'retainedHeapBytes', 'timedHeapGrowthBytes']
      .map(key => [key, median(rows.map(row => row[key]))]))];
  }));
  if (revisions.before && revisions.before.births !== revisions.after.births) {
    throw new Error(`${kind} ${count}: revisions produced different birth counts.`);
  }
  summary.push({ kind, count, ...revisions });
}
const result = { node: process.version, platform: process.platform, arch: process.arch,
  repetitions, warmupFrames: 60, measuredFrames: 90, deltaTime: 1 / 60, summary, samples };
if (values.output) await writeFile(values.output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
