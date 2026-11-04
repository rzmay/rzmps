# Event-routing overhead and CI preview policy

The supplied PR report compares `develop@63ccce7` with `sources-events@9ca8066`.
Its +9.32% average-update geometric mean does not represent a 9% increase in every workload.
Percentages give very small timings the same weight as much larger ones.

The churn cases add 0.69–0.91 ms per CPU update and 0.13–0.17 ms in GPU mode. Those are measurable
costs, even though the GPU percentages of 80–94% describe sub-millisecond changes. Excluding the six
churn rows, the average-update geometric mean is approximately +0.9% and P95 approximately +3.4%,
calculated from the rounded table values. Excluding the 50k CPU sprite row as well gives approximately
+0.2% and +2.8%. These exclusions locate the changes; they do not replace the complete report.

The 50k CPU sprite row is significant in absolute terms: 58.85 to 71.76 ms, or +12.91 ms. Its reported
FPS falls from 16.6 to 13.7. The other cases often remain at the 60 Hz frame cap, so unchanged FPS
there does not establish unchanged update cost.

## Measured event overhead

Every CPU birth/death published a system event, reconciled receiver subscriptions, and inspected
emitter scopes and options, including ordinary emitters with no event subscriptions. Reconciliation
also built default options for empty components. The new fast path bypasses producer resolution
and emitter routing when there are no configured subscriptions. Removing existing subscriptions
still reconciles them, and raw configuration is checked again on the next dispatch, preserving changes
made between updates and relationship overrides.

On this Apple M4 Pro, an isolated fixed-step test at 2,000 births/sec and 0.2-second particle lifetime
used seven alternating before/after repetitions, 120 warmup frames, and 300 measured frames at 60 Hz.
Before/after here means the same events branch before and after this fast path, not develop.

| Measurement | Before | After |
| --- | ---: | ---: |
| Median update, instrumentation disabled | 1.118 ms | 0.143 ms |
| Emitter option resolutions over 300 steps, separately instrumented | 61,500 | 1,500 |
| Final live particles | 396 | 396 |

These timings include simulation and particle creation. They demonstrate a concrete removable
cost; they do not predict an 87% improvement for complete rendered effects or for the CI suite.
Regression tests cover subscriptions added/removed between updates and changed attachment triggers.

## Focused comparison against develop

The same machine built `develop@63ccce7` and this branch independently and ran ABBA browser samples.
The 50k CPU sprite case used the CI profile, vsync, 1-second warmup and 4-second measurement.
It averaged 24.056 ms on develop and 23.575 ms after the fix. Individual develop runs ranged from
23.040 to 25.073 ms; branch runs ranged from 23.143 to 24.008 ms. The reported 12.91 ms slowdown
was not reproduced. This does not prove that the Linux runner's tail-latency result was harmless.

The churn cases used CI-mode software WebGPU flags, vsync, a 640×360 viewport, 0.5-second warmup,
and 1.5-second measurement. The following are averages of two runs per revision, not hardware GPU
execution timestamps. The host was macOS rather than the GitHub Ubuntu runner.

| Case | Develop | After fix | Absolute change |
| --- | ---: | ---: | ---: |
| Spawn churn CPU | 1.171 ms | 1.380 ms | +0.209 ms |
| Spawn churn GPU mode | 0.290 ms | 0.280 ms | -0.010 ms |
| Custom volume churn CPU | 1.174 ms | 1.410 ms | +0.235 ms |
| Custom volume churn GPU mode | 0.248 ms | 0.284 ms | +0.035 ms |
| Surface churn CPU | 1.119 ms | 1.164 ms | +0.045 ms |
| Surface churn GPU mode | 0.221 ms | 0.265 ms | +0.045 ms |

Residual overhead remains in some cases. Event ownership and Source-space metadata are additional
work relative to develop, but these measurements do not attribute the remaining milliseconds to
specific instructions or buffers. A new CI comparison is needed before claiming the aggregate PR
regression has been eliminated. The benchmark workflow and its reporting formula were left intact.

## Deployment and committed previews

The Dawn device-loss error is also reported upstream by Three.js. It is not established as exclusive
to GitHub runners. Render's build invokes `site:build` with `CI=true`, which previously reached the
same browser-based preview generation path. Therefore an ignore-failure flag would not establish
that deployment succeeds or that every example has a valid image.

Preview PNGs and `apps/docs/public/previews/manifest.json` are now committed inputs to build checks.
`npm run docs:generate` explicitly generates missing or stale captures locally and retains its bounded
Dawn-error retry. Contributors review and commit images and the manifest with source changes.
`--check`, CI, and deployment validate source fingerprints and image checksums without launching a
browser. Missing, edited, or stale previews fail with regeneration instructions. The separate visual
workflow continues to run actual browser tests, including WebGPU. No GPU failures are ignored.

CI and deployment skip Puppeteer's browser download. Render's configured Node version is aligned
with the repository's Node 24 requirement. This policy removes headless GPU work from static-site
builds; it does not change WebGPU device-loss behavior in a visitor's browser.
