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
