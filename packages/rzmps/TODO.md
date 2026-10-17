# Follow-up TODOs

- Investigate jitter in audio attached to fast-moving GPU particles. Selective readback is asynchronous and currently has no render-time interpolation.
- Investigate remaining behavior corruption when switching systems between GPU and CPU processing. This affects multiple systems even after reset and needs a dedicated lifecycle/state audit.
- Fix moving spatial effects on both CPU and GPU. Moving effect transforms currently produce incorrect influence, and the GPU update path becomes disproportionately slow.
