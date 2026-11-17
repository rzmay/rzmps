# Benchmark measurements

`BenchmarkPage.jsx` owns deterministic scenarios and the animation-frame loop. Each measured case starts a
`ParticleSystem.benchmarks` session after warmup. Frame intervals and existing dispatch diagnostics feed that collector;
its report supplies the existing comparison fields. Event drains run outside the measured window. Renderer profiling
wraps the one normal scene render, after simulation, without changing fixed simulation steps or requesting GPU timestamps.

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

## Gas workloads in the full suite

The default/full selection includes eight GPU-only gas cases. `suite=gas` selects just these cases;
short PR selection IDs remain unchanged. `apps/demo/src/benchmark/gasBenchmarks.js` owns the fixtures.
Smoke, fire, a finer pressure workload and a lighting-heavy plume report steady-state measurements.
Separate startup, quality-adoption, resident-capacity and ten-second sustained-smoke cases cover lifecycle work.
Preparation and forced lifecycle operations occur before the ordinary steady measurement window.

Each result's `gas` object distinguishes CPU submission, fenced wall intervals, compute-pipeline creation,
and timestamped GPU execution. The workload includes cell width, subdivisions, physical bounds,
resident/active pages and cells, solver, particle count, lighting probes/effective spacing/storage and
render scale/viewport. Residual/divergence diagnostics are included when the solver provides them.

`gpuPassTimer.js` captures actual native pass intervals. Each category is an interval union; rendering
excludes compute overlap in the combined total. Stage categories can overlap each other and their
independently measured medians must not be added. Scene rendering includes raymarch/reconstruction and
other scene work; it is not an isolated raymarch-kernel measurement. Missing timestamp support produces
null GPU metrics, never a CPU/fence substitute. No result requires a machine-specific FPS target.
Storage bytes are owned-resource estimates, not total VRAM. Detailed pass logs stay in internal runners.

For deeper investigation, `internal/smoke-lifecycle.mjs` retains streamed checkpoints, device-loss/error
capture, heartbeat/render ages and tracked allocations. Set `SMOKE_STRESS=1` for scene changes and camera
repositioning during the run. These long diagnostic logs are not added to ordinary benchmark output.
