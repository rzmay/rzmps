/** Native WebGPU allocation accounting. Bytes describe requested storage, not driver residency/RSS.
 * Metadata never holds the GPU resources alive. Install before workload preparation/compilation. */
export function trackGPUResources(device, context = () => ({}), { backend } = {}) {
  const live = new Map(),
    records = new Map(),
    events = [],
    restores = [];
  const native = new WeakMap(),
    annotations = new WeakMap(),
    pending = new Set();
  let peak = { time: 0, ids: [] },
    scope = {};
  const semantic = (record, at = Infinity) => {
    const history = record.annotations ?? [];
    return history.findLast(entry => entry.time <= at)?.info ?? record.info;
  };
  const annotateNative = (resource, info, history) => {
    const record = native.get(resource);
    if (!record) return;
    const previous = semantic(record);
    if (JSON.stringify(previous) === JSON.stringify(info)) return;
    record.annotations ??= [];
    record.annotations.push(
      ...(history ?? [{ time: record.annotations.length ? performance.now() : record.createdAt, info }]),
    );
    event('annotate', { id: record.id, info });
  };
  const resolve = target => {
    if (native.has(target)) return target;
    if (backend?.has && !backend.has(target)) return;
    const data = backend?.get?.(target);
    return data?.buffer ?? data?.texture;
  };
  const cleanInfo = info => {
    const result = {};
    for (const key of ['owner', 'category', 'purpose', 'generation', 'state', 'pool']) {
      if (info[key] === undefined) continue;
      if (!['string', 'number'].includes(typeof info[key])) throw new TypeError('Memory annotations must be primitive');
      result[key] = info[key];
    }
    if (info.segments)
      result.segments = info.segments.map(({ category, bytes }) => {
        if (typeof category !== 'string' || !Number.isFinite(bytes) || bytes < 0)
          throw new TypeError('Invalid GPU memory segment');
        return { category, bytes };
      });
    return result;
  };
  const annotate = (target, input) => {
    const info = cleanInfo(input);
    if (!target || typeof target !== 'object') return;
    let history = annotations.get(target);
    if (!history) {
      history = [];
      annotations.set(target, history);
    }
    if (JSON.stringify(history.at(-1)?.info) !== JSON.stringify(info)) history.push({ time: performance.now(), info });
    const resource = resolve(target);
    if (resource && native.has(resource)) {
      const record = native.get(resource);
      annotateNative(
        resource,
        info,
        record.annotations?.length
          ? undefined
          : history.map((entry, index) => ({ ...entry, time: index ? entry.time : record.createdAt })),
      );
    } else if (history.length === 1) pending.add(new WeakRef(target));
  };
  const refresh = () => {
    for (const reference of pending) {
      const target = reference.deref();
      if (!target) {
        pending.delete(reference);
        continue;
      }
      const resource = resolve(target);
      if (resource && native.has(resource)) {
        const record = native.get(resource),
          history = annotations.get(target);
        annotateNative(
          resource,
          history.at(-1).info,
          history.map((entry, index) => ({ ...entry, time: index ? entry.time : record.createdAt })),
        );
        pending.delete(reference);
      }
    }
  };
  const describe = (record, at = Infinity) => ({
    ...record,
    annotations: undefined,
    ...semantic(record, at),
    destroyedAt: record.destroyedAt ?? null,
  });
  const summarize = (items, at = Infinity) => {
    const byCategory = {},
      byState = {};
    for (const record of items) {
      const info = semantic(record, at);
      for (const segment of info.segments ?? [{ category: info.category, bytes: record.bytes }])
        byCategory[segment.category] = (byCategory[segment.category] ?? 0) + segment.bytes;
      const state = info.state ?? 'current';
      byState[state] = (byState[state] ?? 0) + record.bytes;
    }
    return { byCategory, byState };
  };
  const totals = {
    buffers: 0,
    textures: 0,
    createdBytes: 0,
    destroyedBytes: 0,
    liveBytes: 0,
    peakBytes: 0,
    destructionCount: 0,
    pipelineCreations: 0,
    pendingFences: 0,
    uploadCalls: 0,
    uploadBytes: 0,
  };
  let identity = 0;
  const event = (type, data) => events.push({ time: performance.now(), ...context(), type, ...data });
  const wrap = (owner, name, callback) => {
    const original = owner[name];
    owner[name] = callback(original);
    restores.push(() => {
      owner[name] = original;
    });
  };
  const uploads = new Map();
  wrap(
    device.queue,
    'writeBuffer',
    original =>
      function (buffer, offset, data, dataOffset = 0, size) {
        const stride = ArrayBuffer.isView(data) ? (data.BYTES_PER_ELEMENT ?? 1) : 1;
        const bytes = size === undefined ? data.byteLength - dataOffset * stride : size * stride;
        totals.uploadCalls++;
        totals.uploadBytes += bytes;
        const scope = context(),
          key = scope.frame;
        let record = uploads.get(key);
        if (!record) {
          record = { time: performance.now(), ...scope, type: 'upload', bytes: 0, calls: 0 };
          uploads.set(key, record);
          events.push(record);
        }
        record.bytes += bytes;
        record.calls++;
        return original.call(this, buffer, offset, data, dataOffset, size);
      },
  );

  for (const [method, kind] of [
    ['createBuffer', 'buffers'],
    ['createTexture', 'textures'],
  ]) {
    wrap(
      device,
      method,
      original =>
        function (descriptor) {
          const start = performance.now(),
            resource = original.call(this, descriptor),
            id = ++identity;
          const bytes = kind === 'buffers' ? descriptor.size : textureBytes(descriptor);
          const record = {
            id,
            kind,
            bytes,
            label: descriptor.label ?? '',
            createdAt: performance.now(),
            info: {
              owner: 'renderer',
              category:
                kind === 'textures'
                  ? 'renderer textures / depth / transient targets'
                  : descriptor.usage & 1
                    ? 'diagnostic / timestamp resources'
                    : descriptor.usage & 64
                      ? 'renderer textures / depth / transient targets'
                      : 'other / unattributed',
              purpose: descriptor.label || method,
              generation: 0,
              state: 'current',
              ...scope,
            },
          };
          records.set(id, record);
          native.set(resource, record);
          live.set(id, record);
          totals[kind]++;
          totals.createdBytes += bytes;
          totals.liveBytes += bytes;
          if (totals.liveBytes > totals.peakBytes) {
            totals.peakBytes = totals.liveBytes;
            peak = { time: record.createdAt, ids: [...live.keys()] };
          }
          event('create', { ...record, cpuMs: performance.now() - start });
          const destroy = resource.destroy;
          resource.destroy = function (...args) {
            if (live.delete(id)) {
              record.destroyedAt = performance.now();
              totals.destructionCount++;
              totals.destroyedBytes += bytes;
              totals.liveBytes -= bytes;
              event('destroy', record);
            }
            return destroy.apply(this, args);
          };
          return resource;
        },
    );
  }

  for (const method of [
    'createComputePipeline',
    'createComputePipelineAsync',
    'createRenderPipeline',
    'createRenderPipelineAsync',
  ]) {
    wrap(
      device,
      method,
      original =>
        function (descriptor) {
          totals.pipelineCreations++;
          event('pipeline', { method, label: descriptor.label ?? '' });
          return original.call(this, descriptor);
        },
    );
  }

  wrap(
    device.queue,
    'onSubmittedWorkDone',
    original =>
      function () {
        totals.pendingFences++;
        const start = performance.now();
        return original.call(this).finally(() => {
          totals.pendingFences--;
          event('fence-complete', { latencyMs: performance.now() - start });
        });
      },
  );

  return {
    events,
    annotate,
    refresh,
    scope(info, callback) {
      const previous = scope;
      scope = { ...scope, ...cleanInfo(info) };
      try {
        return callback();
      } finally {
        scope = previous;
      }
    },
    semanticSnapshot() {
      refresh();
      const allocations = [...live.values()];
      const summary = summarize(allocations);
      return {
        time: performance.now(),
        ...totals,
        ...summary,
        liveAllocations: allocations.length,
        attributedFraction: totals.liveBytes
          ? 1 - (summary.byCategory['other / unattributed'] ?? 0) / totals.liveBytes
          : 1,
        largest: allocations
          .sort((a, b) => b.bytes - a.bytes)
          .slice(0, 24)
          .map(record => describe(record)),
      };
    },
    peakSnapshot() {
      refresh();
      const allocations = peak.ids.map(id => records.get(id));
      return {
        time: peak.time,
        bytes: totals.peakBytes,
        ...summarize(allocations, peak.time),
        allocations: allocations.map(record => describe(record, peak.time)).sort((a, b) => b.bytes - a.bytes),
      };
    },
    categoryPeaks() {
      const changes = [];
      for (const record of records.values()) {
        const parts = info => info.segments ?? [{ category: info.category, bytes: record.bytes }];
        let previous = parts(semantic(record, record.createdAt));
        const change = (time, segments, sign) =>
          segments.forEach(part => changes.push({ time, category: part.category, bytes: part.bytes * sign }));
        change(record.createdAt, previous, 1);
        for (const entry of record.annotations ?? []) {
          if (entry.time <= record.createdAt || entry.time >= (record.destroyedAt ?? Infinity)) continue;
          const next = parts(entry.info);
          if (JSON.stringify(previous) === JSON.stringify(next)) continue;
          change(entry.time, previous, -1);
          change(entry.time, next, 1);
          previous = next;
        }
        if (record.destroyedAt !== undefined) change(record.destroyedAt, previous, -1);
      }
      const current = {},
        peaks = {};
      for (const event of changes.sort((a, b) => a.time - b.time || b.bytes - a.bytes)) {
        current[event.category] = (current[event.category] ?? 0) + event.bytes;
        peaks[event.category] = Math.max(peaks[event.category] ?? 0, current[event.category]);
      }
      return peaks;
    },
    records() {
      return [...records.values()].map(record => describe(record));
    },
    snapshot() {
      return { ...totals, liveAllocations: live.size };
    },
    live() {
      return [...live.values()].map(record => describe(record));
    },
    restore() {
      restores.reverse().forEach(restore => restore());
    },
  };
}

/** Include mip chains, array layers, 3D depth and multisampling in requested texture storage. */
export function textureBytes(descriptor) {
  const size = descriptor.size;
  const [width, height, depth] = Array.isArray(size)
    ? [size[0], size[1] ?? 1, size[2] ?? 1]
    : [size.width, size.height ?? 1, size.depthOrArrayLayers ?? 1];
  const format = descriptor.format;
  const bits = {
    r8: 8,
    rg8: 16,
    rgba8: 32,
    bgra8: 32,
    r16: 16,
    rg16: 32,
    rgba16: 64,
    r32: 32,
    rg32: 64,
    rgba32: 128,
    rgb10a2: 32,
    rg11b10: 32,
    rgb9e5: 32,
    depth16: 16,
    depth24plus: 32,
    depth32: 32,
    stencil8: 8,
  };
  const prefix = Object.keys(bits).find(key => format.startsWith(key));
  if (!prefix) throw new Error(`Unaccounted GPU texture format: ${format}`);
  let texels = 0;
  for (let level = 0; level < (descriptor.mipLevelCount ?? 1); level++) {
    texels +=
      Math.max(1, width >> level) *
      Math.max(1, height >> level) *
      (descriptor.dimension === '3d' ? Math.max(1, depth >> level) : depth);
  }
  return ((texels * bits[prefix]) / 8) * (descriptor.sampleCount ?? 1);
}
