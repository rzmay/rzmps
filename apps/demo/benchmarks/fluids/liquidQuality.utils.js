import * as THREE from 'three';
import { StorageBufferAttribute } from 'three/webgpu';
import { Fn, instanceIndex, storage, vec4, max } from 'three/tsl';

/** A compact, explicit checkpoint. Never runs inside an ordinarily timed frame. */
export async function readLiquidMarkers(system, renderer) {
  const buffers = system.gpuSimulation._gpuBuffers;
  const count = buffers?.count ?? 0;
  if (!count) return [];
  const attribute = new StorageBufferAttribute(new Float32Array(count * 12), 4);
  const output = storage(attribute, 'vec4', count * 3);
  const node = Fn(() => {
    const particle = buffers.storage.createParticle(undefined, true), base = instanceIndex.mul(3);
    output.element(base).assign(vec4(particle.position, particle.mass));
    output.element(base.add(1)).assign(vec4(particle.velocity.mul(particle.speed), particle.alive));
    output.element(base.add(2)).assign(vec4(max(particle.scale.x, max(particle.scale.y, particle.scale.z)),
      particle.generation, 0, 0));
  })().compute(count);
  try {
    renderer.compute(node);
    const data = new Float32Array(await renderer.getArrayBufferAsync(attribute)), markers = [];
    for (let i = 0; i < count; i++) if (data[i * 12 + 7] > 0) markers.push({
      id: `${i}:${data[i * 12 + 9]}`, position: [...data.slice(i * 12, i * 12 + 3)],
      mass: data[i * 12 + 3], velocity: [...data.slice(i * 12 + 4, i * 12 + 7)], radius: data[i * 12 + 8],
    });
    return markers;
  } finally {
    node.dispose();
    renderer.backend.destroyAttribute(attribute);
    attribute.dispose();
  }
}

/** World-space conservation and wall-interior tests; no grid-relative velocities or inferred particle counts. */
export function markerMetrics(markers, boxes = []) {
  const mass = markers.reduce((sum, particle) => sum + particle.mass, 0);
  const momentum = [0, 0, 0], centroid = [0, 0, 0];
  let kineticEnergy = 0, penetrations = 0, maxPenetration = 0, nonFiniteSamples = 0;
  for (const particle of markers) {
    if (![...particle.position, ...particle.velocity, particle.mass].every(Number.isFinite)) nonFiniteSamples++;
    for (let axis = 0; axis < 3; axis++) {
      momentum[axis] += particle.mass * particle.velocity[axis];
      centroid[axis] += particle.mass * particle.position[axis];
      kineticEnergy += 0.5 * particle.mass * particle.velocity[axis] ** 2;
    }
    const depth = Math.max(0, ...boxes.map(box => Math.min(...box.halfSize.map((half, axis) =>
      half - Math.abs(particle.position[axis] - box.center[axis])))));
    if (depth > 1e-4) penetrations++;
    maxPenetration = Math.max(maxPenetration, depth);
  }
  return { particles: markers.length, mass, momentum, centroid: centroid.map(value => value / (mass || 1)),
    kineticEnergy, rmsSpeed: Math.sqrt(2 * kineticEnergy / (mass || 1)),
    colliderInteriorParticles: penetrations, maxPenetration, nonFiniteSamples };
}

export function compareMarkers(before, after, executedSeconds = 0) {
  const previous = new Map(before.map(particle => [particle.id, particle]));
  let retained = 0, displacementSq = 0, translationErrorSq = 0;
  for (const particle of after) {
    const source = previous.get(particle.id);
    if (!source) continue;
    retained++;
    for (let axis = 0; axis < 3; axis++) {
      const distance = particle.position[axis] - source.position[axis];
      displacementSq += distance ** 2;
      translationErrorSq += (distance - source.velocity[axis] * executedSeconds) ** 2;
    }
  }
  const incoming = markerMetrics(before), outgoing = markerMetrics(after);
  return { particleRetention: retained / Math.max(1, before.length),
    massRetention: outgoing.mass / (incoming.mass || 1),
    rmsWorldDisplacement: Math.sqrt(displacementSq / Math.max(1, retained)),
    rmsTranslationError: Math.sqrt(translationErrorSq / Math.max(1, retained)),
    incomingMomentum: incoming.momentum, outgoingMomentum: outgoing.momentum,
    momentumDrift: Math.hypot(...outgoing.momentum.map((value, axis) => value - incoming.momentum[axis])),
  };
}

export async function liquidCheckpoint(system, renderer) {
  const { flip, surface, boxes } = system.__liquidFixture;
  const markers = await readLiquidMarkers(system, renderer), particles = markerMetrics(markers, boxes);
  const pressure = await flip.getPressureProjection().readDiagnostics(renderer, flip.velocityCurrent);
  const grid = flip.workGrid;
  const pages = new Uint32Array(await renderer.getArrayBufferAsync(grid.diagnosticsAttribute));
  const mesh = surface ? await surface.readSurfaceDiagnostics() : null;
  let boundsCoverage = null, invalidSurfaceIndices = 0, nonFiniteSurfaceVertices = 0;
  if (surface?.surface && markers.length && mesh.triangles > 0) {
    // Surface-nets vertices retain sparse cell addresses: only the drawn index stream is authoritative.
    const geometry = surface.surface;
    const [positions, indices] = await Promise.all([
      renderer.getArrayBufferAsync(geometry.positionAttribute), renderer.getArrayBufferAsync(geometry.indexAttribute),
    ]);
    const vertices = new Float32Array(positions), drawn = new Uint32Array(indices);
    const bounds = new THREE.Box3(), point = new THREE.Vector3();
    for (const index of new Set(drawn.subarray(0, mesh.triangles * 3))) {
      if (index * 4 + 2 >= vertices.length) { invalidSurfaceIndices++; continue; }
      point.fromArray(vertices, index * 4);
      if (![point.x, point.y, point.z].every(Number.isFinite)) { nonFiniteSurfaceVertices++; continue; }
      bounds.expandByPoint(point);
    }
    bounds.expandByScalar(surface.voxelSize);
    boundsCoverage = markers.filter(particle => bounds.containsPoint(
      point.fromArray(particle.position))).length / markers.length;
  }
  return { markers, quality: { ...particles, pressure,
    hydrostatic: { rmsSpeed: particles.rmsSpeed,
      kineticEnergyPerMass: particles.kineticEnergy / (particles.mass || 1),
      centerOfMassHeight: particles.centroid[1] },
    surface: mesh ? { ...mesh, boundsCoverage, invalidSurfaceIndices, nonFiniteSurfaceVertices,
      extraction: String(surface.extraction),
      coverageProxy: 'particle centers inside vertex bounds; overflow counts reported separately' } : null },
  workload: { particleCount: markers.length, residentPages: pages[0], activePages: pages[5],
    residentCapacity: grid.capacity, activeCells: pages[5] * grid.cellsPerBrick,
    residentCells: pages[0] * grid.cellsPerBrick,
    allocatedCells: grid.cellCount, deniedPages: pages[1], requestedPages: pages[2],
    cellWidth: flip.cellSize, subdivisions: [grid.brickSubdivisions, grid.cellSubdivisions],
    bounds: [...flip.bounds.min.toArray(), ...flip.bounds.max.toArray()],
    pressureSolver: 'Iterative', pressure: { ...pressure }, surfaceExtraction: surface?.extraction ?? null,
    triangles: mesh?.triangles ?? 0, vertices: mesh?.vertices ?? 0,
    colliders: { count: boxes.length, types: { box: boxes.length } },
    viewport: renderer.getDrawingBufferSize(new THREE.Vector2()).toArray() } };
}
