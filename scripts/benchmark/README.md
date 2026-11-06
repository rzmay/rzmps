# TextureAtlas timing benchmark

Run `npm run benchmark:atlas -- benchmark/texture-atlas.json` from the repository root.
This builds the library, starts an isolated Vite page, and measures native WebGL and WebGPU
in headless Chromium. It requires localhost binding and GPU access. The JSON includes adapter
and browser details. The default output, without an argument, is in `/tmp`.

Each case uses 8, 32 or 128 distinct RGBA8 DataTextures, with 128×128 source pixels and atlas
interiors, plus two gutter pixels on each edge. It measures:

- First bake, including source upload, target allocation and shader/pipeline preparation.
- One dirty tile and all dirty tiles, with five warmups followed by 30 samples (median/p95).
- Unchanged updates and repeated aliases, in 30 batches of 1,000 operations.
- Adding a new source to a free cell, without invalidating existing tiles.

`submit` is JavaScript wall time inside `atlas.update(renderer)`. `complete` additionally waits
for `gl.finish()` or `queue.onSubmittedWorkDone()`. These are browser-observed wall times,
including driver/queue overhead, rather than GPU timestamp-query durations. First-bake results
are single observations, affected by JIT and shader caches; they are not scaling comparisons.
Image decoding and network loading are excluded. Larger source uploads, other devices and
concurrent rendering can change the results. Run without other GPU workloads for comparison.

No CPU texture readback is used. GPU completion waits occur only in the benchmark.

For sustained collision checks, run `node scripts/preview/checkDestruction.mjs`. It captures
mesh debris on Checkerboard and UV debug scenes using both backends, through 62 seconds of
repeated impacts. Each checkpoint checks that debris remains present; WebGPU also checks native
simulation and the eight-storage-buffer limit. The output directory defaults to
`/tmp/rzmps-destruction-lifetime`. Sampling-mode and sprite regressions live in
`tests/visual/mesh-batch.test.mjs`; the Destruction demo itself stays mesh-only with UV patches.
