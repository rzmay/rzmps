/* eslint-env browser */
/* global GPUBufferUsage, GPUMapMode */
const assert = (value, message) => { if (!value) throw new Error(message); };
// Count actual passes, including pass restarts, rather than Three's per-frame pool aggregate.
// In this Three version initTimestampQuery shares a mutable timestampWrites object across
// descriptors. Install a fresh dictionary at the actual begin*Pass call to avoid that alias.
export function passTimer(device, backend, getStage, { slots = 1 } = {}) {
  assert(Number.isInteger(slots) && slots > 0, 'Timestamp slots must be positive');
  const count = 4096, bytes = count * 8;
  const pool = Array.from({ length: slots }, () => ({
    queries: device.createQuerySet({ type: 'timestamp', count }),
    resolve: device.createBuffer({ size: bytes, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
    read: device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    busy: false,
  }));
  let current;
  const createEncoder = device.createCommandEncoder, init = backend.initTimestampQuery;
  let active = false, passes = [];
  backend.initTimestampQuery = function (type, uid, descriptor) {
    if (active) { descriptor.timestampWrites = undefined; return; }
    return init.call(this, type, uid, descriptor);
  };
  device.createCommandEncoder = function (...args) {
    const encoder = createEncoder.apply(this, args);
    for (const [method, type] of [['beginComputePass', 'compute'], ['beginRenderPass', 'render']]) {
      const begin = encoder[method];
      encoder[method] = function (descriptor = {}) {
        if (!active) return begin.call(this, descriptor);
        const index = passes.length * 2;
        assert(index + 1 < count, 'Pass timestamp counter exhausted');
        passes.push({ type, stage: getStage(type, descriptor), label: descriptor.label ?? '' });
        return begin.call(this, { ...descriptor, timestampWrites: { querySet: current.queries,
          beginningOfPassWriteIndex: index, endOfPassWriteIndex: index + 1 } });
      };
    }
    return encoder;
  };
  const unionMs = intervals => {
    let end = 0n, duration = 0n;
    for (const [low, high] of intervals.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) {
      if (high > end) { duration += high - (low > end ? low : end); end = high; }
    }
    return Number(duration) / 1e6;
  };
  return {
    // Busy slots drop diagnostic samples; they never stall simulation or reuse mapped storage.
    start() {
      assert(!active, 'Timestamp frame already active');
      current = pool.find(slot => !slot.busy);
      if (!current) return false;
      current.busy = true; passes = []; active = true;
      return true;
    },
    async finish() {
      assert(active, 'No active timestamp frame');
      active = false;
      const slot = current, captured = passes;
      const { queries, resolve, read } = slot;
      assert(captured.length > 0, 'No pass timestamps captured');
      const used = captured.length * 2, encoder = createEncoder.call(device);
      encoder.resolveQuerySet(queries, 0, used, resolve, 0);
      encoder.copyBufferToBuffer(resolve, 0, read, 0, used * 8);
      device.queue.submit([encoder.finish()]);
      try {
        await read.mapAsync(GPUMapMode.READ, 0, used * 8);
        const times = new BigUint64Array(read.getMappedRange(0, used * 8));
        const intervals = captured.map((pass, i) => {
          const low = times[2 * i], high = times[2 * i + 1];
          assert(high >= low && low > 0n, 'Invalid pass timestamps');
          return { ...pass, low, high, ms: Number(high - low) / 1e6 };
        });
        const computeIntervals = intervals.filter(pass => pass.type === 'compute');
        const renderIntervals = intervals.filter(pass => pass.type === 'render');
        const pairs = items => items.map(pass => [pass.low, pass.high]);
        const computeGPUms = unionMs(pairs(computeIntervals)), renderPassGPUms = unionMs(pairs(renderIntervals));
        const totalGPUms = unionMs(pairs(intervals));
        const byStage = items => Object.fromEntries([...new Set(items.map(pass => pass.stage))]
          .map(stage => [stage, unionMs(pairs(items.filter(pass => pass.stage === stage)))]));
        const stageGPUms = byStage(computeIntervals), renderStageGPUms = byStage(renderIntervals);
        const lighting = computeIntervals.filter(pass => pass.stage.startsWith('lighting/'));
        const volume = computeIntervals.filter(pass => pass.stage.startsWith('volume/'));
        const surface = computeIntervals.filter(pass => pass.stage.startsWith('liquid/surface '));
        const secondary = computeIntervals.filter(pass => pass.stage === 'liquid/secondary-particle/spray work');
        const simulation = computeIntervals.filter(pass => !lighting.includes(pass) && !volume.includes(pass)
          && !surface.includes(pass) && !secondary.includes(pass));
        return { computeGPUms, renderGPUms: totalGPUms - computeGPUms, totalGPUms, stageGPUms, renderStageGPUms,
          allStageGPUms: byStage(intervals), surfaceComputeGPUms: unionMs(pairs(surface)),
          secondaryGPUms: unionMs(pairs(secondary)),
          simulationGPUms: unionMs(pairs(simulation)), lightingGPUms: unionMs(pairs(lighting)),
          volumeComputeGPUms: unionMs(pairs(volume)),
          renderPassGPUms, computeRenderOverlapGPUms: Math.max(0, computeGPUms + renderPassGPUms - totalGPUms),
          passCounts: { compute: computeIntervals.length, render: renderIntervals.length },
          passes: intervals.map(({ low, high, ...pass }) => ({ ...pass,
            startMs: Number(low - times[0]) / 1e6, endMs: Number(high - times[0]) / 1e6 })) };
      } finally { read.unmap(); slot.busy = false; }
    },
    dispose() {
      active = false; device.createCommandEncoder = createEncoder; backend.initTimestampQuery = init;
      for (const { queries, resolve, read } of pool) { queries.destroy(); resolve.destroy(); read.destroy(); }
    },
  };
}
