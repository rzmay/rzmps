import { Benchmarks, BenchmarkMetricType } from '@rzmps/rzmps';

/** Semantic ownership adapters for the generic native tracker. No physics or allocation policy is changed.
 * Only explicit component storage is traversed; shader graphs/scene graphs are not retained by the audit. */
export function attributeFluidMemory(tracker, renderer, system, scene) {
  const benchmarks = new Benchmarks();
  system.benchmarks.attach('memory', benchmarks);
  let latest = {};
  const gauge = (name, get, unit = 'bytes') =>
    benchmarks.register(name, { type: BenchmarkMetricType.Gauge, unit, get });
  gauge('liveRequestedBytes', () => latest.liveBytes ?? 0);
  gauge('peakRequestedBytes', () => latest.peakBytes ?? 0);
  gauge('preparedBytes', () => latest.byState?.prepared ?? 0);
  gauge('retiredAwaitingFenceBytes', () => latest.byState?.retired ?? 0);
  gauge('compilerOwnedBytes', () => latest.byState?.['compiler-owned'] ?? 0);
  gauge('attributedFraction', () => latest.attributedFraction ?? 0, 'ratio');
  const ids = new WeakMap(),
    tagged = new WeakMap(),
    monitored = new WeakSet();
  const pendingPreparations = new Set(),
    seenPreparations = new WeakSet();
  const methodOriginals = new WeakMap(),
    projections = new WeakSet(),
    retiredPayloads = new WeakSet();
  const observations = new WeakMap();
  const restores = [],
    pools = [],
    poolOriginals = new WeakMap();
  let serial = 0;
  const identity = value => {
    if (!value || typeof value !== 'object') return 0;
    if (!ids.has(value)) ids.set(value, ++serial);
    return ids.get(value);
  };
  const tag = (target, info, force = false) => {
    if (!target || typeof target !== 'object') return;
    const previous = tagged.get(target);
    if (previous && (info.owner === 'scene' || info.generic)) return;
    // A canceled borrower cannot retire backing still owned by the live generation.
    if (previous?.state === 'current' && info.state !== 'current' && info.generation !== previous.generation) return;
    if (
      previous &&
      ['owner', 'category', 'generation', 'state', 'pool'].every(key => previous[key] === info[key]) &&
      JSON.stringify(previous.segments) === JSON.stringify(info.segments)
    )
      return;
    // A prepared program may borrow current storage. It is not another allocation or replacement byte.
    if (
      !force &&
      previous &&
      ((previous.state === 'current' && info.state === 'prepared') || info.category === 'other / unattributed')
    )
      return;
    tagged.set(target, info);
    tracker.annotate(target, info);
  };
  const storage = (object, info, depth = 0, visited = new WeakSet()) => {
    if (!object || typeof object !== 'object' || visited.has(object)) return;
    visited.add(object);
    if (object.isBufferAttribute || object.isInterleavedBufferAttribute || object.isTexture) {
      tag(object.isInterleavedBufferAttribute ? object.data : object, info);
      return;
    }
    if (object.isNode) {
      if (!tagged.has(object.value)) storage(object.value, info, 0, visited);
      return;
    }
    if (object.isRenderTarget) {
      storage(object.texture, info, 0, visited);
      storage(object.depthTexture, info, 0, visited);
      return;
    }
    if (ArrayBuffer.isView(object)) return;
    for (const [name, value] of object instanceof Map ? object : Object.entries(object)) {
      if (
        [
          'sourceAttributes',
          'source',
          'options',
          'context',
          'renderer',
          'system',
          'parent',
          'input',
          'execution',
        ].includes(name)
      )
        continue;
      const child = { ...info, purpose: `${info.purpose}/${name}` };
      if (Array.isArray(value)) value.forEach(item => storage(item, child, depth, visited));
      else if (value?.isBufferAttribute || value?.isTexture || value?.isNode || value?.isRenderTarget)
        storage(value, child, 0, visited);
      else if (depth > 0 && value && typeof value === 'object') storage(value, child, depth - 1, visited);
    }
  };
  const info = (owner, category, purpose, generation, state = 'current', pool) => ({
    owner,
    category,
    purpose,
    generation,
    state,
    ...(pool ? { pool } : {}),
  });
  const pressure = (projection, owner, state, generation, pool) => {
    if (projection && !projections.has(projection)) {
      projections.add(projection);
      wrap(projection, 'prepareStencil', self => {
        const claim = tagged.get(self.attribute);
        pressure(self, owner, claim?.state ?? state, claim?.generation ?? generation, pool);
      });
    }
    storage(
      projection,
      info(owner, 'pressure solver scratch', 'pressure face/operator storage', generation, state, pool),
    );
    storage(
      projection?.reduction,
      info(owner, 'pressure reductions / multigrid', 'pressure reductions', generation, state, pool),
      1,
    );
    storage(
      projection?.multigrid,
      info(owner, 'pressure reductions / multigrid', 'multigrid hierarchy', generation, state, pool),
      3,
    );
  };
  const fieldCategory = (name, gas) => {
    if (name.startsWith('pressure')) return 'pressure fields';
    if (name.startsWith('velocity')) return gas ? 'gas velocity fields' : 'FLIP velocity/grid fields';
    if (/densityAttribute|colorAttribute/.test(name)) return 'persistent density / heat / color fields';
    if (/boundary|solid/.test(name)) return 'collider / baked occupancy fields';
    if (/visual/.test(name)) return 'source / event / transient visual storage';
    if (/maxima/.test(name)) return 'pressure reductions / multigrid';
    return 'transport / solver scratch';
  };
  const fluid = (module, owner, state = 'current') => {
    if (!module) return;
    const gas = module.constructor.name === 'GasSimulation';
    const generation = identity(module.velocityCurrentAttribute),
      pool = `${owner}/resident`;
    for (const [key, value] of Object.entries(module)) {
      if (value?.isBufferAttribute) tag(value, info(owner, fieldCategory(key, gas), key, generation, state, pool));
    }
    storage(
      module.advectionAttributes,
      info(owner, 'transport / solver scratch', 'MacCormack intermediates', generation, state, pool),
    );
    const grid = module.workGrid ?? module.volumeGrid;
    storage(
      grid,
      info(
        owner,
        gas ? 'sparse gas resident pools' : 'sparse FLIP resident pools',
        'sparse page directory / dispatch / admission',
        generation,
        state,
        pool,
      ),
    );
    pressure(module.pressureProjection, owner, state, generation, pool);
    for (const key of ['boundaryReduction', 'transferReduction', 'guardPrediction'])
      storage(module[key], info(owner, 'pressure reductions / multigrid', key, generation, state, pool), 1);
    for (const key of ['densityTexture', 'colorTexture', 'velocityTexture'])
      tag(
        module[key],
        info(
          owner,
          key === 'velocityTexture' ? 'derived velocity textures' : 'derived density / color / parameter textures',
          key,
          generation,
          state,
          `${owner}/exports`,
        ),
      );
    storage(
      module.particleCollisionBackend,
      info(owner, 'collider / baked occupancy fields', 'collision BVH', generation, state),
      2,
    );
    for (const collider of module.fluidColliders ?? [])
      storage(
        collider.gpuField,
        info(owner, 'collider / baked occupancy fields', 'shared geometry occupancy bake', generation, state),
        2,
      );
  };
  const surface = (helper, owner, state = 'current') => {
    if (!helper) return;
    const generation = identity(helper),
      pool = `${owner}/surface`;
    for (const [key, value] of Object.entries(helper))
      if (
        value?.isBufferAttribute &&
        key !== 'fieldAttribute' &&
        !(key === 'smoothingAttribute' && value === helper.fieldScratchAttribute)
      ) {
        const category = /fieldScratch|kernel/.test(key)
          ? 'anisotropy / reconstruction scratch'
          : /topology|index|counters|vertexMap/.test(key)
            ? 'surface topology / extraction buffers'
            : 'surface attributes / draw buffers';
        tag(value, info(owner, category, key, generation, state, pool));
      }
    if (helper.fieldAttribute) {
      const n = helper.grid.cellCount;
      tag(helper.fieldAttribute, {
        ...info(owner, 'surface packed fields', 'scalar / color / momentum / curl', generation, state, pool),
        segments: [
          { category: 'surface scalar / support fields', bytes: n * 4 },
          { category: 'surface color / momentum fields', bytes: n * 28 },
          { category: 'anisotropy / reconstruction scratch', bytes: n * 16 },
        ],
      });
    }
    storage(helper.grid, info(owner, 'sparse surface pools', 'surface page directory', generation, state, pool));
    storage(
      helper.projection,
      info(owner, 'particle spatial index', 'surface particle projection', generation, state),
      1,
    );
    storage(helper.queryGrid, info(owner, 'particle spatial index', 'surface query index', generation, state), 1);
  };
  const poolPayload = (payload, owner, kind, state, module) => {
    if (!payload) return;
    if (kind === 'surface') {
      surface(payload, owner, state);
      return;
    }
    if (payload.context) {
      fluid(payload.context, owner, state);
      return;
    }
    const generation = identity(payload),
      pool = `${owner}/${kind}`;
    if (kind === 'exports') {
      for (const key of ['density', 'color', 'velocity'])
        tag(
          payload[key],
          info(
            owner,
            key === 'velocity' ? 'derived velocity textures' : 'derived density / color / parameter textures',
            `replacement ${key}`,
            generation,
            state,
            pool,
          ),
        );
      return;
    }
    const keys = Object.keys(module).filter(key => module[key]?.isBufferAttribute);
    const byAttribute = new Map(keys.map(key => [module[key], key]));
    const original = module.fieldAttributes ?? [];
    const gas = module.constructor.name === 'GasSimulation';
    for (let index = 0; index < (payload.attributes?.length ?? 0); index++) {
      const key = byAttribute.get(original[index]) ?? `field-${index}`;
      tag(
        payload.attributes[index],
        info(owner, fieldCategory(key, gas), key, generation, state, `${owner}/resident`),
      );
    }
    storage(
      payload.grid,
      info(owner, gas ? 'sparse gas resident pools' : 'sparse liquid resident pools',
        'replacement directory', generation, state, `${owner}/resident`),
    );
    storage(
      payload.pressure,
      info(owner, 'pressure solver scratch', 'replacement pressure capacity', generation, state, `${owner}/resident`),
      2,
    );
  };
  const monitorPool = (pool, owner, kind, module) => {
    if (!pool?.options?.create || monitored.has(pool)) return;
    monitored.add(pool);
    pools.push({ reference: new WeakRef(pool), owner, kind });
    let stagedReference;
    const retire = (payload, state = 'retired') => {
      if (!payload) return;
      retiredPayloads.add(payload);
      poolPayload(payload, owner, kind, state, module);
    };
    wrap(pool, 'cancelPending', () =>
      retire(stagedReference?.deref(), pool.status.state === 'preparing' ? 'compiler-owned' : 'retired'),
    );
    wrap(pool, 'dispose', () => {
      retire(pool.current);
      retire(stagedReference?.deref());
    });
    const options = pool.options,
      create = options.create,
      prepare = options.prepare,
      swap = options.swap;
    options.create = function (...args) {
      const result = create.apply(this, args);
      const mark = result => {
        stagedReference = new WeakRef(result);
        poolPayload(result, owner, kind, 'prepared', module);
        return result;
      };
      return result?.then ? result.then(mark) : mark(result);
    };
    options.prepare = async function (payload) {
      poolPayload(payload, owner, kind, retiredPayloads.has(payload) ? 'compiler-owned' : 'prepared', module);
      await prepare.call(this, payload);
      poolPayload(payload, owner, kind, retiredPayloads.has(payload) ? 'retired' : 'prepared', module);
    };
    options.swap = function (next) {
      // Physical allocations shared by old/new owners are relabeled current by the second call.
      poolPayload(pool.current, owner, kind, 'retired', module);
      const result = swap.call(this, next);
      poolPayload(next, owner, kind, 'current', module);
      return result;
    };
    poolOriginals.set(options, { create, prepare, swap });
    const reference = new WeakRef(options);
    restores.push(() => {
      const options = reference.deref();
      if (options) Object.assign(options, poolOriginals.get(options));
    });
  };
  const wrap = (object, method, after) => {
    if (!object?.[method]) return;
    const original = object[method];
    object[method] = function (...args) {
      const result = original.apply(this, args);
      after(this, result);
      return result;
    };
    let originals = methodOriginals.get(object);
    if (!originals) methodOriginals.set(object, (originals = new Map()));
    originals.set(method, original);
    const reference = new WeakRef(object);
    restores.push(() => {
      const object = reference.deref();
      if (object) object[method] = methodOriginals.get(object).get(method);
    });
  };
  const owners = [system, ...system.subSystems.keys()];
  for (const ownerSystem of owners)
    for (const module of ownerSystem.modules) {
      if (!/^(FLIP|Gas)Simulation$/.test(module.constructor.name)) continue;
      const owner = `${ownerSystem.name || 'ParticleSystem'}/${module.constructor.name}`;
      const ensure = module.ensureGridResolution;
      module.ensureGridResolution = function (...args) {
        const old = this.workGrid ?? this.volumeGrid;
        if (this === module && old && Math.abs(old.cellSize - args[1].cellSize) > 1e-9) fluid(this, owner, 'retired');
        try {
          return ensure.apply(this, args);
        } finally {
          fluid(this, owner, this === module ? 'current' : 'prepared');
        }
      };
      restores.push(() => {
        module.ensureGridResolution = ensure;
      });
      const cancelQuality = module.cancelQualityPreparation;
      if (cancelQuality) {
        module.cancelQualityPreparation = function (...args) {
          const candidate = this.qualityPreparation;
          const state = candidate?.ready ? 'retired' : 'compiler-owned';
          if (candidate?.pool?.context) fluid(candidate.pool.context, owner, state);
          else if (candidate) {
            storage(
              candidate.grid,
              info(owner, 'sparse gas resident pools', 'canceled quality directory', identity(candidate), state),
            );
            pressure(candidate.pressure, owner, state, identity(candidate), `${owner}/resident`);
          }
          return cancelQuality.apply(this, args);
        };
        restores.push(() => {
          module.cancelQualityPreparation = cancelQuality;
        });
      }
      wrap(module, 'prepareQualityChange', self => {
        const completion = self.qualityPreparation?.completion;
        if (completion && !seenPreparations.has(completion)) {
          seenPreparations.add(completion);
          pendingPreparations.add(completion);
          const done = () => pendingPreparations.delete(completion);
          void completion.then(done, done);
        }
      });
      wrap(module, 'forkGridResources', (_self, target) => fluid(target, owner, 'prepared'));
      wrap(module, 'getPressureProjection', (self, result) =>
        pressure(
          result,
          owner,
          self === module ? 'current' : 'prepared',
          identity(self.velocityCurrentAttribute),
          `${owner}/resident`,
        ),
      );
      wrap(module, 'ensureWorkPool', () => monitorPool(module.workPool, owner, 'resident', module));
      wrap(module, 'ensurePoolAllocation', () => monitorPool(module.poolAllocation, owner, 'resident', module));
      wrap(module, 'ensureTextureCapacity', () => monitorPool(module.textureAllocation, owner, 'exports', module));
    }
  const efficiency = (owner, kind, capacity, useful, bytes, extra = {}) => ({
    owner,
    kind,
    capacity,
    useful,
    utilization: capacity ? useful / capacity : 0,
    bytes,
    bytesPerReserved: capacity ? bytes / capacity : 0,
    bytesPerUseful: useful ? bytes / useful : null,
    ...extra,
  });
  const scan = () => {
    const efficiencies = [];
    for (const ownerSystem of owners) {
      const owner = ownerSystem.name || 'ParticleSystem';
      const category = /foam/i.test(owner)
        ? 'foam particle storage'
        : /spray/i.test(owner)
          ? 'spray particle storage'
          : 'particle / source storage';
      storage(ownerSystem.gpuSimulation._gpuBuffers, info(owner, category, 'particle state', 0), 1);
      storage(
        ownerSystem.gpuSimulation._gpuRenderOutputBuffers,
        info(owner, 'source / event / transient visual storage', 'particle render output', 0),
        1,
      );
      storage(
        ownerSystem.gpuSimulation,
        {
          ...info(owner, 'source / event / transient visual storage', 'GPU emission / event / transient scratch', 0),
          generic: true,
        },
        2,
      );
      storage(
        ownerSystem.spatialRuntime._particleSpatialGrids,
        info(owner, 'particle spatial index', 'managed spatial indices', 0),
        1,
      );
      for (const module of ownerSystem.modules)
        if (/^(FLIP|Gas)Simulation$/.test(module.constructor.name)) {
          const moduleOwner = `${owner}/${module.constructor.name}`;
          fluid(module, moduleOwner);
          const pending = module.qualityPreparation;
          if (pending?.pool?.context) fluid(pending.pool.context, moduleOwner, 'prepared');
          else if (pending) {
            storage(
              pending.grid,
              info(
                moduleOwner,
                'sparse gas resident pools',
                'prepared quality directory',
                identity(pending),
                'prepared',
              ),
            );
            pressure(pending.pressure, moduleOwner, 'prepared', identity(pending), `${moduleOwner}/resident`);
            storage(
              pending.temporary,
              info(moduleOwner, 'transport / solver scratch', 'quality resampling', identity(pending), 'prepared'),
              1,
            );
          }
          monitorPool(module.workPool ?? module.poolAllocation, moduleOwner, 'resident', module);
          monitorPool(module.textureAllocation, moduleOwner, 'exports', module);
        }
      for (const view of ownerSystem.renderers) {
        const viewOwner = `${owner}/${view.constructor.name}`;
        surface(view.surface, viewOwner);
        if (view.allocation) {
          monitorPool(view.allocation, viewOwner, 'surface');
          surface(view.allocation.pending?.resources, viewOwner, 'prepared');
        }
        storage(
          view._gpuChildren?.output,
          info(viewOwner, 'renderer-child buffers', 'visual child particle state', 0),
          1,
        );
        storage(view._gpuChildren, info(viewOwner, 'renderer-child buffers', 'visual child arena', 0), 1);
        const lighting = view.lightingGrid;
        if (lighting) {
          for (const [index, cascade] of lighting.cascades.entries())
            for (const key of ['local', 'merged', 'mean', 'projected'])
              tag(
                cascade[key],
                info(
                  viewOwner,
                  /local|merged/.test(key)
                    ? 'LightingGrid radiance / transmittance'
                    : 'LightingGrid hierarchy / intermediates',
                  `cascade ${index} ${key}`,
                  identity(cascade),
                ),
              );
          for (const key of ['scatterTexture', 'lightTexture', 'environmentProjection'])
            storage(lighting[key], info(viewOwner, 'LightingGrid hierarchy / intermediates', key, 0), 2);
        }
        for (const value of Object.values(view))
          if (value?.isRenderTarget)
            storage(value, info(viewOwner, 'volume renderer targets / depth / reconstruction', 'volume target', 0));
      }
    }
    scene?.traverse(object => {
      if (object.geometry && !object.parent?.isParticleSystem)
        storage(object.geometry.attributes, info('scene', 'renderer geometry', object.name || 'scene geometry', 0));
    });
    tracker.refresh();
    const snapshot = tracker.semanticSnapshot();
    latest = snapshot;
    for (const category of Object.keys(snapshot.byCategory)) {
      const name = `categories/${category.replaceAll('/', '-').replaceAll(' ', '_')}`;
      if (!benchmarks.has(name)) gauge(name, () => latest.byCategory?.[category] ?? 0);
    }
    const live = tracker.live();
    for (const ownerSystem of owners)
      for (const module of ownerSystem.modules) {
        const grid = module.workGrid ?? module.volumeGrid;
        if (!grid) continue;
        const owner = `${ownerSystem.name || 'ParticleSystem'}/${module.constructor.name}`;
        const bytes = live
          .filter(item => item.pool === `${owner}/resident` && item.state === 'current')
          .reduce((sum, item) => sum + item.bytes, 0);
        const metrics = module.benchmarks.snapshot();
        const useful = observations.get(grid)?.resident ?? metrics.residentPages ?? metrics.activeBricks ?? 0;
        efficiencies.push(
          efficiency(owner, 'resident pages', grid.capacity, useful, bytes, {
            cellWidth: module.cellSize,
            dimensions: module.gridDimensions.toArray(),
            requested: observations.get(grid)?.requested ?? metrics.requestedPages,
            denied: observations.get(grid)?.denied ?? metrics.deniedPages,
          }),
        );
      }
    for (const ownerSystem of owners)
      for (const view of ownerSystem.renderers) {
        const owner = `${ownerSystem.name || 'ParticleSystem'}/${view.constructor.name}`;
        if (view.surface) {
          const stats = view.benchmarks.snapshot();
          const bytes = live
            .filter(item => item.pool === `${owner}/surface` && item.state === 'current')
            .reduce((sum, item) => sum + item.bytes, 0);
          efficiencies.push(
            efficiency(owner, 'surface pages', view.surface.grid.capacity, stats.activeBricks ?? 0, bytes, {
              vertices: stats.vertexCount,
              triangles: stats.triangleCount,
              vertexCapacity: view.surface.outputVertexCapacity,
              triangleCapacity: view.surface.triangleCapacity,
            }),
          );
        }
        if (view.lightingGrid) {
          const grid = view.lightingGrid;
          const probes = grid.cascades.reduce(
            (sum, level) => sum + level.dimensions.x * level.dimensions.y * level.dimensions.z,
            0,
          );
          efficiencies.push(
            efficiency(owner, 'lighting probes', probes, grid.statistics.probes, grid.statistics.memoryBytes, {
              spacing: grid.statistics.probeSpacing,
            }),
          );
        }
      }
    latest.pools = efficiencies;
    for (const row of efficiencies) {
      const prefix = `pools/${row.owner}/${row.kind}`;
      for (const key of ['capacity', 'useful', 'utilization', 'bytes', 'bytesPerReserved', 'bytesPerUseful']) {
        const name = `${prefix}/${key}`;
        if (!benchmarks.has(name))
          gauge(
            name,
            () => latest.pools?.find(pool => pool.owner === row.owner && pool.kind === row.kind)?.[key] ?? 0,
            key === 'utilization' ? 'ratio' : key.includes('bytes') ? 'bytes' : 'count',
          );
      }
    }
    return {
      ...snapshot,
      pools: efficiencies,
      staged: pools.flatMap(({ reference, owner, kind }) => {
        const pool = reference.deref();
        return pool ? [{ owner, kind, capacity: pool.capacity, ...pool.status, metrics: { ...pool.metrics } }] : [];
      }),
    };
  };
  return {
    scan,
    async observe() {
      for (const owner of owners)
        for (const module of owner.modules) {
          const grid = module.workGrid ?? module.volumeGrid;
          if (!grid) continue;
          const values = new Uint32Array(await renderer.getArrayBufferAsync(grid.diagnosticsAttribute));
          observations.set(grid, { resident: values[0], requested: values[2], denied: values[1] });
        }
    },
    async whenIdle() {
      await Promise.allSettled([
        ...pendingPreparations,
        ...pools.flatMap(({ reference }) => {
          const pool = reference.deref();
          return pool ? [pool.whenPrepared()] : [];
        }),
      ]);
    },
    restore() {
      restores.reverse().forEach(restore => restore());
      benchmarks.dispose();
    },
  };
}
