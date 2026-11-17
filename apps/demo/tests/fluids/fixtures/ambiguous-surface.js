import { StorageBufferAttribute, WebGPURenderer } from 'three/webgpu';
import { Fn, float, instanceIndex, ivec3, storage, vec3 } from 'three/tsl';
import buildMarchingCubesPass from '../../../../../packages/rzmps/src/rendering/gpu/buildMarchingCubesPass';

const renderer = new WebGPURenderer({ trackTimestamp: true });
await renderer.init();
window.extractAmbiguous = async (variant, decider) => {
  const n = 5, cells = n ** 3, maximumTriangles = 2048;
  const values = new Float32Array(cells * 4);
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const inside = Math.min(x, y, z) > 0 && Math.max(x, y, z) < n - 1;
    const sign = (x + y + z) % 2 ? -1 : 1;
    values[(x + n * (y + n * z)) * 4 + 3] = inside
      ? sign * (variant === 0 ? 1 : sign > 0 ? variant === 1 ? 2 : 0.5 : 1) : -1;
  }
  const field = new StorageBufferAttribute(values, 4);
  const positions = new StorageBufferAttribute(maximumTriangles * 3, 4);
  const indices = new StorageBufferAttribute(new Uint32Array(maximumTriangles * 3), 1);
  const counters = new StorageBufferAttribute(new Uint32Array(3), 1);
  const context = {
    grid: { cellCount: cells, cellsPerAxis: n,
      coordinate: index => ivec3(index.mod(n), index.div(n).mod(n), index.div(n * n)),
      index: coordinate => coordinate.x.add(coordinate.y.mul(n)).add(coordinate.z.mul(n * n)),
      compute: callback => Fn(() => callback(instanceIndex))().compute(cells) },
    field: storage(field, 'vec4', cells), positions: storage(positions, 'vec4', maximumTriangles * 3),
    indices: storage(indices, 'uint', maximumTriangles * 3),
    counters: storage(counters, 'uint', 3).toAtomic(),
    iso: float(0), minimum: vec3(0), cellSize: float(1), maximumTriangles,
  };
  const { nodes } = buildMarchingCubesPass(context, decider);
  await renderer.compileComputeAsync(nodes);
  renderer.compute(nodes);
  await renderer.backend.device.queue.onSubmittedWorkDone();
  await renderer.resolveTimestampsAsync('compute');
  const gpuMs = renderer.info.compute.timestamp;
  const count = new Uint32Array(await renderer.getArrayBufferAsync(counters))[0];
  const points = new Float32Array(await renderer.getArrayBufferAsync(positions));
  const edges = new Map();
  for (let triangle = 0; triangle < count; triangle++) {
    const vertices = [0, 1, 2].map(vertex => [...points.slice((triangle * 3 + vertex) * 4,
      (triangle * 3 + vertex) * 4 + 3)].map(value => Math.round(value * 1e5)).join(','));
    for (let i = 0; i < 3; i++) {
      const key = [vertices[i], vertices[(i + 1) % 3]].sort().join('|');
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  const openEdges = [...edges.values()].filter(value => value === 1).length;
  const nonManifoldEdges = [...edges.values()].filter(value => value > 2).length;
  nodes.forEach(node => node.dispose());
  [field, positions, indices, counters].forEach(attribute => attribute.dispose());
  return { count, openEdges, nonManifoldEdges, gpuMs, variant, decider,
    open: [...edges].filter(([, count]) => count === 1).slice(0, 10),
    nonManifold: [...edges].filter(([, count]) => count > 2).slice(0, 4) };
};
window.ready = true;
