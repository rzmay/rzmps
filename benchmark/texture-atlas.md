# TextureAtlas measurements

Run: 2026-10-27T05:39:49.320Z. Apple M4 Pro; headless Chromium 154, native ANGLE/Metal WebGL and WebGPU.

One atlas per case, 128×128 RGBA8 source textures and tile interiors, two-pixel gutters.
See [benchmark procedure](../scripts/benchmark/README.md) and [raw results](texture-atlas.json).

CPU submission time in milliseconds; unchanged updates in microseconds. Values are median / p95.

| Backend | Tiles | Unchanged (µs) | One dirty tile (ms) | All dirty tiles (ms) |
| --- | ---: | ---: | ---: | ---: |
| webgl | 8 | 0.035 / 0.165 | 0.015 / 0.145 | 0.065 / 0.105 |
| webgl | 32 | 0.100 / 0.250 | 0.010 / 0.015 | 0.095 / 0.210 |
| webgl | 128 | 0.380 / 0.415 | 0.005 / 0.010 | 0.205 / 0.330 |
| webgpu | 8 | 0.035 / 0.085 | 0.025 / 0.055 | 0.160 / 0.210 |
| webgpu | 32 | 0.115 / 0.135 | 0.025 / 0.045 | 0.385 / 0.510 |
| webgpu | 128 | 0.350 / 0.375 | 0.020 / 0.040 | 1.520 / 1.800 |

Browser-observed wall time in milliseconds, including GPU completion waits:

| Backend | Tiles | All dirty tiles, median / p95 | First bake (single observation) | Add to free cell (single observation) |
| --- | ---: | ---: | ---: | ---: |
| webgl | 8 | 0.070 / 0.105 | 10.585 | 0.250 |
| webgl | 32 | 0.100 / 0.215 | 3.080 | 0.200 |
| webgl | 128 | 0.205 / 0.330 | 5.315 | 0.150 |
| webgpu | 8 | 0.420 / 0.630 | 19.370 | 1.560 |
| webgpu | 32 | 1.105 / 1.270 | 11.730 | 1.510 |
| webgpu | 128 | 3.900 / 4.215 | 35.125 | 1.620 |

Unchanged frames submit no atlas draws. The remaining version polling grows linearly with source
count but stayed below one microsecond per update in these cases. Aliases use a texture-identity map.
Adding to a free cell now bakes only the new tile; changing grid dimensions still rebakes all tiles.

The initial bake includes allocation, texture uploads and shader/pipeline setup and can hitch.
First-bake observations are sensitive to JIT and shader caches, so their non-monotonic values are
not evidence that larger atlases bake faster. Warm rebakes are suitable for occasional updates;
rebaking large atlases every frame, especially across several material channels, still has a cost.

Completion waits use gl.finish() / queue.onSubmittedWorkDone(); they measure browser/driver wall
time, not GPU timestamp-query execution time. Decoding and network loading are excluded. These
synthetic single-atlas cases do not establish performance on mobile or other browser/device pairs.

Reproduce: `npm run benchmark:atlas -- benchmark/texture-atlas.json`.
