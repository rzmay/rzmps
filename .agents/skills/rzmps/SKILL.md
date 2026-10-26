---
name: rzmps
description: Build and debug Three.js particle systems and VFX in RZMPS using emitters, modules, renderers, and WebGL/WebGPU canvas previews.
---

<!-- Generated from apps/docs/guides/ai-coding-assistants.md. Do not edit. -->

Inspect the installed package version and public exports before using a feature. In this repository, use the current branch's TypeScript source. Prefer existing emitters, modules, renderers, and spatial effects before adding custom behavior.

Read [getting started](references/getting-started.md) for scene ownership and updates, [concepts](references/concepts.md) for lifecycle, priority, tags, spatial collections, and subsystem composition, and [GPU processing](references/concepts.md#gpu-processing-and-extension-development) before implementing TSL callbacks, readback, collision, or spatial-grid behavior. Search the [generated API](references/api.md) for signatures.

Reuse a canonical factory from `examples/`; inspect [example explanations](references/examples.md) for its configuration rationale. Preserve the default factory and author metadata contracts. Add balanced documentation source regions and update the authored Markdown explanation, then run `npm run docs:generate` and `npm run docs:check`.

Check the selected renderer and custom material compatibility using [compatibility](references/compatibility.md). Build packages, run `npm run preview -- --example <id> --backend webgl`, and inspect the contact sheet and metadata. Repeat with webgpu when relevant; report unavailable backends explicitly. Adjust warmup, interval, or scene to capture the actual event. Technical success alone does not establish visual quality.

Update root systems once; parents own subsystem timing. Follow Module, Renderer, Emitter, and SpatialEffect CPU/GPU extension hooks and priority semantics. Do not treat WebGPU rendering as proof of GPU simulation; check component support and `isGPUProcessingActive`. Use features present in the installed version and current branch. Reference files are generated from human documentation; edit their canonical source instead.

Repository preview scripts and `examples/` are checkout tools. In a consumer project, adapt an example to its existing rendering loop or use a repository checkout for previews; do not assume consumers have repository npm scripts. Read the [installation guidance](references/concepts.md#installation) before installing the skill or changing agent configuration.
