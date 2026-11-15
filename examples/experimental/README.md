# Fluid stability and frame-time follow-up

This is the current investigation record, replacing the historical infrastructure summary.
Measurements describe local native Chromium/WebGPU runs, not guaranteed performance.
Internal diagnostics remain separate from published benchmark tables and PR benchmark reports.

## Two distinct failures

| Symptom | Classification | Current evidence |
| --- | --- | --- |
| A slow frame, followed by normal rendering and camera movement | Recoverable stall | Quality adoption still constructs transport graphs/pipelines on the submitting frame. |
| Viewport/camera stop permanently while the profiler remains active | Persistent viewport freeze | User reports Volumetric Smoke on Color Lights. Memory/device failure remains a hypothesis, not a confirmed cause. |
| Sustained low FPS while updates continue | Workload cost | Track gas compute, lighting, raymarch cost, domain/cell width and resident cells separately. |

An exception escaping the render loop can also leave the profiler alive. It must not be described
as a GPU out-of-memory failure without a device error, device loss or allocation evidence.

## Corrections in this pass

### Bounded volume render targets

The reduced-resolution target map previously retained every scale visited by adaptive resolution or
user edits. Each entry contains two half-float RGBA attachments, approximately
`width * height * 16` bytes. Changing resolution repeatedly could retain substantial unused storage.

The map now keeps the active scale and one recent scale, disposing older targets. Fixed full-resolution
rendering releases inactive targets. This changes resource retention, not raymarch quality or simulation.
The upsampling regression checks the cache bound and full-resolution release alongside depth continuity.

This is a demonstrated retention problem, **not proof that it caused the reported persistent freeze**.

### Oversized lighting layouts

A large valid gas domain could exceed the lighting texture's packed directional-Z dimension and throw
`LightingGrid texture dimensions exceed 2048`. That exception could abort the display loop.

Lighting now doubles effective probe spacing only when required to fit the packed texture dimensions.
Requested `cellSize` is retained, smaller domains restore it, and `statistics.probeSpacing` exposes the
actual spacing. A deterministic large-domain/shrink test covers this behavior.

The limit protects texture dimensions only. A dense lighting layout can still consume significant memory
while fitting each dimension; a total probe-memory budget is a separate unresolved question.

### Diagnostics that distinguish the failures

`scripts/benchmark/internal/smoke-lifecycle.mjs` runs the real demo and records:

- Independent RAF heartbeat, successful outer-render age and system-update age.
- Browser exceptions, uncaptured WebGPU errors and device-loss reason.
- Long tasks, quality-preparation stages, actual cell width, bounds and resident capacity.
- Gas/render GPU stage timings, lighting storage, target count and target attachment bytes.
- Created/destroyed GPU buffers and textures, plus live/peak allocation deltas since instrumentation began.

The allocation counter is not total VRAM: pre-existing resources, canvas storage and driver overhead
are excluded. Buffer/texture bytes are estimates; do not add overlapping subsystem totals to it.
Checkpoints stream only new samples to NDJSON. An earlier version serialized all accumulated browser
history every two seconds, creating artificial periodic stalls; those gaps are excluded from conclusions.

## Recoverable quality-transition stalls

The candidate path prepares replacement directory/pressure/remap programs asynchronously, but adoption
still resets transport/source/export caches. Tests that evolve support while preparation runs expose
additional destination retargeting and particle-directory generation invalidation.

A trial that prepared transport against a prototype resource view did not retain the prepared caches
at adoption. It was removed rather than shipping extra compilation and unvalidated captured bindings.

Targeted forced transitions measured approximately **64–66 new compute pipelines** and **289–320 ms CPU
submission** on the first changed-quality frame. These are instrumented forced-transition measurements,
not representative steady-state GPU time. A real smoke baseline also recorded consecutive **138 ms and
101 ms main-thread long tasks** around a quality change near 15 seconds.

The next corrective step is to prepare transport against the final destination identities and reconcile
the particle-directory generation before adoption. Validate both ping-pong identities, visual refresh,
source index rebinding and retirement fences. Preparation must not mutate live graph caches or fields.
Pressure, transport, boundary baking and the first renderer draw need separate timing at adoption.

This is a recoverable hitch. It does not establish the cause of a permanent viewport freeze.

## Reproduction measurements

Baseline runs used a 1000×750 viewport at device pixel ratio 2, automatic quality and native WebGPU:

| Fixture | Duration | Observed behavior |
| --- | --- | --- |
| Smoke / Checkerboard | 40 s | Median intervals initially ~16.7 ms, later ~24–28 ms, ending ~20–21 ms; cell width changed 0.125 → 0.25 near 15 s. |
| Fire / Color Lights | 40 s | Median interval ~16.6 ms; cell width stayed 0.125. |

Neither baseline reproduced a persistent freeze, device loss or browser exception. Smoke reached
1024 resident slots, ~163 MB reported gas storage and ~120–132 MB lighting storage. Tracked allocation
delta peaked near 457 MB; this is not total process/GPU memory. Fire reported ~155 MB gas storage,
~13 MB lighting storage and a tracked peak near 256 MB. Old checkpoint-induced periodic gaps are
not production frame-time evidence. These runs used different workloads and are not an optimization A/B.

Raw baseline captures: `/tmp/gas-long-smoke.json`, `/tmp/gas-long-fire.json`.
The follow-up ran **Smoke / Color Lights for 51.5 seconds** with bounded targets and streaming
checkpoints (`/tmp/gas-long-smoke-colors-fixed.json`):

- 2,004 successful outer renders; no browser exceptions, GPU error or device-loss events.
  Final render age was 1 ms, update age 2.9 ms and independent heartbeat age 0.9 ms.
- Median frame intervals started at 16.7 ms, rose to 29–30 ms during 15–30 s, and settled around
  22–25 ms later. Median update CPU time stayed about 1.1–1.3 ms outside transitions.
- Quality changed from cell width 0.125 to 0.25 near 12.3 s, with consecutive 146 ms and 129 ms
  main-thread long tasks. This reproduced a recoverable stall, not a persistent freeze.
- Lighting storage grew from ~18 MB to ~132–160 MB as probe coverage grew. Resident capacity stayed
  at 1024 after startup. The tracked live allocation delta ended near 418 MB, with a similar peak.
- Reduced-resolution targets never exceeded two entries. At final scale 0.5 they occupied ~29.3 MB;
  peak target storage was ~69.6 MB. This is a verified bound, not a matched memory-saving A/B.

Across 48 instrumented frames after 15 s, median exclusive GPU totals were ~21.0 ms compute and
~13.1 ms render (~32.3 ms combined). These medians are measured independently and need not add exactly.
The lighting/render compute bucket was ~12.1 ms and brick-activation bucket ~5.5 ms; pressure sweeps
were ~0.92 ms, scalar transport ~0.15 ms. CPU stage labels and nested pressure counters overlap,
so they must not be summed as independent work. Render-pass spans also overlap compute and each other.

This points to growing lighting coverage and activation-stage work as sustained-cost targets in this
fixture, rather than assuming pressure alone explains late FPS loss. The activation bucket includes
support/reduction/dispatch work, not just the already-cheap ordered page-admission kernel. Split those
components before optimizing or changing the allocator. The independently captured draw spans also
show substantial raster/raymarch cost. A longer run may still reproduce the user's persistent freeze;
this finite run cannot rule it out.

## Remaining work and acceptance criteria

1. **Persistent freezes:** reproduce Smoke / Color Lights beyond the short fixtures, including repeated
   scene changes and quality transitions. Preserve the last successful render, pending quality stage,
   allocation history, exception and device-loss evidence. Do not call a recoverable stall a freeze.
2. **Quality adoption:** eliminate first-frame transport compilation without weakening field retention
   or rendering. Count new pipelines and CPU submission time separately from queue completion.
3. **Sustained FPS:** correlate changes with active cells, pressure work, lighting probe count and render
   GPU time. Domain growth/admission is already separately measured; do not redesign it without evidence.
4. **Memory:** verify target storage remains bounded across resolution cycles. If a valid dense lighting
   layout exhausts memory, test a probe budget or staged replacement based on an actual failure capture.
5. **FLIP:** the previously reported long-run slowdown around 13,000 particles remains a separate
   workload investigation; this gas-focused pass does not claim to have remeasured or fixed it.

Reproduce the current targeted diagnostic:

```sh
SMOKE_PRESET='Volumetric Smoke' SMOKE_SCENE='Color Lights' \
SMOKE_SECONDS=50 SMOKE_DPR=2 SMOKE_SWITCH=0 \
SMOKE_OUTPUT=/tmp/gas-long-smoke-colors-fixed.json \
node scripts/benchmark/internal/smoke-lifecycle.mjs
```

Leave `SMOKE_SWITCH` unset to additionally switch scenes after the sustained run. JSONL checkpoints
survive an interrupted run; the aggregate JSON is written when the run finishes.
