# Benchmark workspace

This private workspace gathers benchmark definitions from root `benchmarks/` and each
declared npm workspace's `benchmarks/` directory. Workloads stay with the feature they measure:
browser particle scenarios are in `apps/demo/benchmarks/`, Node microbenchmarks in
`packages/rzmps/benchmarks/`. Root `lib/` owns selection, comparison, reporting and PR orchestration;
`build.mjs` and `browser.mjs` own the browser harness. Shared process/browser helpers live in `scripts/`.

## Running and selecting

From the repository root:

```sh
npm run benchmarks -- --set pr --list
npm run benchmarks -- --set reported --profile ci --simulation-clock fixed
npm run benchmarks -- --set full --backend gpu --feature spatial --split
npm run benchmarks -- --set full --runtime node --repetitions 3
npm run benchmarks -- --set full --path 'apps/demo/benchmarks/.*spatial' --name collision
```

`--list` discovers metadata without importing workloads or building anything. Browser entries in
this listing are modules; their case names and CPU/GPU variants are selected in the browser after
case construction. `--skip-build` reuses built library packages. Browser harness builds remain
necessary. `--output <directory>` overrides the default repository-relative output directory.
Node-specific `--counts`, `--baseline` and `--repetitions` are forwarded to the microbenchmarks.

`config/sets.json` defines `full` (all definitions), `reported` (33 standard browser cases),
`pr` (16 cases, including TrailRenderer CPU/GPU), `cpu`, `gpu`, and feature categories.
Rules match case `name`, repository-relative `path`, `feature`, `backend` or `runtime` using
case-insensitive regular expressions; `*` matches everything. Fields within a rule are ANDed,
rules are ORed. `extends` unions parent sets before local inclusion/exclusion. CLI filters further
restrict the chosen set. Prefer excluding unwanted groups from a parent to copying case lists.

`config/measurement.json` defines default and CI duration, warmup and resolution.
`config/lifecycle.json` owns retries, total deadlines, heartbeat and bounded cleanup settings.
Existing `RZMPS_BENCHMARK_*` environment overrides remain available for CI. Shared Chrome
profiles live in `scripts/config/browser.json`. Change configuration at its owner rather than
adding per-command copies. A slow but valid case should collect enough frames; a failed sample
must not silently become a successful report.

## Adding a benchmark

Name modules `*.benchmark.js` or `*.benchmark.mjs` inside the owning workspace's `benchmarks/`.
Export one default descriptor with literal `id`, `name`, `feature`, `runtime` (`browser` or `node`),
and `backends` (an array of `cpu`/`gpu`). Discovery statically reads these fields without executing
module code. IDs must be stable. Supporting helpers use normal filenames and are not discovered.

Browser descriptors implement `createCases(context)` and return the existing named workload
objects with `create` or `createSystem`. Specify `benchmarkMode`/`backend` for CPU/GPU cases;
shared helpers can generate paired cases. Each normalized case receives an ID, source path,
feature and backend. Optional descriptor `readbackRate` is applied before each case starts.
`context.ciProfile` permits the existing CI workload scaling. Keep the animation loop and timing
in the harness, and keep workload construction in definitions.

Node descriptors implement `async run(options)` and return their measurements. Work runs in a
separate process with `--expose-gc`; importing/listing a definition must not start measurements.
Functional tests of the infrastructure belong in `tests/benchmarks/`, not next to workloads.

## Artifacts and consumers

Generated output is ignored under `benchmarks/output/<set>/`. `browser.json` and `node.json`
contain `{ metadata, results }`; each result includes its identity, feature, path and backend.
Runtime-specific measurements retain their own fields. `index.json` lists artifacts.
`--split` additionally writes `split/<runtime>/<feature>/<backend>.json` without rerunning cases.
Console tables are informational; consumers read JSON. Failures retain diagnostic artifacts.

`npm run update-report --workspace @rzmps/benchmarks` consumes the existing reported browser
artifact and updates root/library README tables; it does not rerun measurements. Use
`-- --input <artifact>` to choose another input. The comparison and PR tools consume the same
browser payload. PR orchestration retains ABBAAB sampling, progressive comments and three samples
per revision. The `benchmark:full` PR label selects the complete reported set (33 cases), while
`--set full` on the root runner includes every workload category. The build adapter supports older branch layouts while keeping each branch's workloads.
Comparisons require compatible settings; cross-revision runs compare shared cases and explicitly report omitted cases.

Fixtures in `tests/benchmarks/fixtures/` are tracked, deterministic inputs, never current
performance reports. Do not refresh them from a benchmark run. No generated result JSON belongs
beside source files.

## Measurement semantics

`BenchmarkPage.jsx` owns deterministic scenarios and the animation-frame loop. Each measured case starts a
`ParticleSystem.benchmarks` session after warmup. Frame intervals and existing dispatch diagnostics feed that collector;
its report supplies the existing comparison fields. Event drains run outside the measured window. Renderer profiling
wraps the normal scene render, after simulation, without changing fixed simulation steps or requesting GPU timestamps.

`benchmark-measurement.mjs` keeps a legacy path for base revisions predating the API. The comparison, ABBAAB ordering,
progressive PR comments, retries and payload validation remain outside the runtime library.

Tinybench was evaluated for this integration. Its public task API owns task execution; externally supplied durations
still arrive through task calls (`overriddenDuration`). Adapting the existing animation-frame/GPU-drain lifecycle or
replaying its samples would add a second scheduler or statistics path without simplifying this suite. We therefore
use the shared `Benchmarks` collector and do not add Tinybench. It can be reconsidered for independent CPU microbenchmarks.
See the [Tinybench task API](https://tinylibs.github.io/tinybench/classes/Task.html).

Renderer metrics have `scope: 'renderer'` and explicit sources. They include unrelated scene objects, and shared memory
must not be summed across systems. Draw counts are deltas for the profiled render callback, accounting for classic
WebGL's automatic reset; provider statistics are sampled after rendering. Explicit GPU timestamp resolution uses Three.js's
public common-renderer API. Classic WebGLRenderer has no such public API; unavailable measurements remain `null`.
