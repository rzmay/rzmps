# Emitter instance lifecycle

The refactor keeps emitter definitions and birth algorithms in `Emitter`. An internal
`EmitterInstance` binds a definition to standalone, live-source, or event-snapshot inputs.
`ParticleSystem._updateEmitterInstances()` discovers executions, advances them, and retires
completed or undiscovered bindings. Instances are never exposed through `ParticleSystem.emitters`.

## State ownership

| Previous structure | Result |
| --- | --- |
| `Emitter._contextStates` | Replaced by owner-specific maps whose values are the instances themselves. |
| CPU `SubSystemEmissionRun` and `_emissionRuns` | Removed; snapshots use the common instance lifecycle. |
| CPU run clocks and context cleanup | Instance timing and common retirement, scoped to the owning system. |
| CPU source-context construction | Shared live/snapshot inheritance in `EmitterInstance.sourceContext()`. |
| GPU `GPUEmitterInstanceRuntime` | Retained; shared indexed request submission and retirement. |
| GPU `GPUEmissionRunBufferState` | Retained compact event snapshots, independent of the original particle's lifetime. |

The system's active-instance set and the emitter's identity lookup reference the same objects.
There is no second copy of rate credit, burst state, or movement history. Snapshot bindings retain
birth inputs without another source reference, source identity, or execution clock inside those inputs.
Emitter configuration remains on the definition. Live bindings are reused instead of reconstructed
every frame. Native GPU particle sources remain indexed entries, with no JavaScript instance per GPU particle.

The public three-argument `Emitter.update()` and one-argument `clearContext()` signatures are retained.
Internal overloads reuse a resolved instance or retire an execution for one owner. Custom `update()`
overrides still execute. Sharing one emitter between systems no longer shares their execution clocks.

## Functional validation

The complete package test suite covers lifecycle and custom events, scopes, ratios, timing, distance
credit, collision inheritance, registered-source updates/removal, source transforms, and lifecycle control.
Additional regressions cover shared-definition ownership and cleanup, definition changes, filtered-source
retirement, event snapshots after source disposal without a callback, and custom emitter overrides.

All 18 browser checks pass on WebGL and WebGPU, including native custom events, nested lifecycle
emission, Source-space attachment and slot reuse, exclusive event origins, and independent birth tags.
GPU checks retain the eight-storage-binding limit and native paths without event readback.

## Same-machine comparison

Measurements used this machine's Apple M4 Pro and Chrome 154. The baseline was the compiled
`sources-events` implementation before this refactor, rather than `develop`. Both browser bundles
used the same benchmark harness, with the library alias selecting the baseline or refactored build.
These comparisons isolate this refactor; they do not measure the entire events branch against develop.

### Registered sources: controlled CPU updates

Five alternating before/after repetitions used 60 warmup steps and 90 measured steps at `1/60` second.
Live sources emit at 12 particles/second. Event sources fire together every 30 steps, with two bursts
per snapshot. Rendering and non-emission modules are disabled; counts include the complete update.

| Binding | Sources | Before, ms/update | After, ms/update | Change | Births in each revision |
| --- | ---: | ---: | ---: | ---: | ---: |
| Live | 8 | 0.1694 | 0.1659 | -2.1% | 136 |
| Live | 256 | 3.5303 | 3.2913 | -6.8% | 4,352 |
| Live | 2,048 | 26.9574 | 26.5167 | -1.6% | 34,816 |
| Snapshot | 8 | 0.1157 | 0.1055 | -8.9% | 48 |
| Snapshot | 256 | 2.0935 | 2.1640 | +3.4% | 1,536 |
| Snapshot | 2,048 | 17.0416 | 16.9337 | -0.6% | 12,288 |

A separate longer ABBA browser check of 2,048 continuous particle sources averaged
6.276 ms before and 6.401 ms after (+2.0%). Individual baseline runs ranged from 6.042 to
6.509 ms; refactored runs ranged from 6.376 to 6.426 ms. The intervals overlap.

Heap checks include source handles and live particles. At 2,048 registered live sources, retained heap
was approximately 20.0 MiB before and 20.2 MiB after. The additional binding/identity and active-set
references explain a small per-source cost. Small-workload heap deltas were noisy. Timed net heap
growth is recorded by the script but is not a measurement of allocated bytes because GC can run
inside the measurement interval. A full allocation profile was not collected.

### Native GPU particle sources

Four browser runs used ABBA order, 1,000 ms warmup and 1,500 ms measurement per case. Continuous
sources emit at 12 particles/second. Custom events fire every 750 ms with two bursts over 400 ms.
Child output capacity is fixed at four times source count to exclude pool growth. The harness counts
actual renderer compute submissions across the hierarchy for this suite, including emission passes.

| Binding | Sources | Instance bytes, both | Snapshot bytes, both | Dispatches/frame, both |
| --- | ---: | ---: | ---: | ---: |
| Live | 8 | 720 | 0 | 10 |
| Live | 256 | 20,560 | 0 | 10 |
| Live | 2,048 | 163,920 | 0 | 10 |
| Snapshot | 8 | 2,640 | 6,656 | 15 |
| Snapshot | 256 | 82,000 | 212,992 | 15 |
| Snapshot | 2,048 | 327,760 | 851,968 | 15 |

Instance storage, snapshot storage, output capacity/bytes, child pipeline/resource builds, and event
readback diagnostics were identical across all four runs. Every child built three pipelines; continuous
children built four resources and event children five. Event readback counts remained zero.
GPU-mode update averages varied between approximately -9% and +3% relative to the baseline.
These are CPU submission times in GPU mode, not GPU timestamp-query measurements of kernel duration.
No additional buffers, per-instance dispatches, or graph rebuilds were introduced.

## Reproduce

Build both revisions first. The Node comparison accepts the baseline's compiled entry point:

```sh
node --expose-gc packages/rzmps/tests/benchmark-emitter-instances.mjs \
  --baseline /path/to/baseline/packages/rzmps/build/index.mjs \
  --output /tmp/emitter-instances-cpu.json
```

Optional `--counts 8,256,2048` and `--repetitions 5` select workload size and repetition count.
For browsers, build two bundles using this revision's benchmark page with each library aliased in turn,
then run each bundle with the same settings:

```sh
RZMPS_BENCHMARK_SUITE=emitter-instances \
RZMPS_BENCHMARK_DURATION_MS=1500 \
RZMPS_BENCHMARK_WARMUP_MS=1000 \
node apps/demo/scripts/benchmark-rzmps.mjs \
  --dist /path/to/benchmark-bundle --output /tmp/emitter-instances-browser.json
```

Repeat in alternating order. The JSON includes instance/snapshot/output bytes, child pipeline/resource
builds, readback diagnostics, heap samples, and actual hierarchy dispatch counts for this suite.
