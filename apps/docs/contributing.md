# Contributing

Install workspace dependencies with `npm install`, then build packages with `npm run build:modules`. Run `npm test` for the library regression suite and `npm run build --workspace demo` for the interactive application.

## Adding or updating an example

Keep the implementation in `examples/<id>.js` (TypeScript is also supported by the generator). Export its existing async default factory and a literal `metadata` object containing id, title, description, tags, and category. Keep configuration inside the factory; the registry is generated. Preserve factory author information and return a normal ParticleSystem so the demo GUI and serializer continue to work.

Mark actual source using balanced `// #region docs:system`, `docs:emitters`, `docs:modules`, and `docs:renderers` comments, closing each with the matching `// #endregion docs:...`. Named suffixes select individual systems or setup blocks. Nested regions are supported; interleaved closures are errors. Repeated region names concatenate their source blocks. If an optional module list is absent, mark a relevant system declaration and explain its absence.

Run `npm run docs:generate`. It discovers the example, updates the registry and indexes, and creates a missing Markdown guide in `apps/docs/examples`. It preserves every existing guide. Replace the four TODO explanations with the purpose of each component and the observable consequences of important values: rate, lifetime, speed, capacity, curves, material, blending, and renderer costs. Keep the four required sections in order. Update the explanations whenever the configuration changes.

Use `<ExampleCode region="system" />` and the equivalent emitter/module/renderer references. Code is extracted from the canonical source during the site build. Never paste a second implementation into the guide. A named reference such as `modules:rocket` selects only that region; the base name selects all its named regions.

## Documentation and API comments

Write conceptual guides in `apps/docs/guides`. Write concise TSDoc on public source declarations describing defaults, lifecycle, mutation, side effects, units, constraints, and performance. Use `@remarks`, `@defaultValue`, `@example`, and `@see` where useful. Avoid repeating the TypeScript signature in prose. Keep tutorials in Markdown.

Use a properly capitalized H1 as each article's title. Add new guides to the appropriate reading
order in `scripts/docs/navigation.mjs`: Getting Started, Core Concepts, Feature Guides, or
Project & Deployment. The sidebar and guide overview read titles directly from the articles;
generation rejects guides missing from this structure. The API overview and sidebar are generated
from actual TypeDoc pages and public export sources by `scripts/docs/api-structure.mjs`. Keep
core classes first and place new API classes in a suitable feature group. Supporting signature
types belong under Types, while Modules contains actual particle modifiers.

`npm run docs:generate` regenerates TypeDoc Markdown, registry/index data, linked agent reference pages, and `llms.txt`/`llms-full.txt`. Those files are generated and must not be edited manually. Example guides, conceptual guides, and `.agents/skills/rzmps/SKILL.md` are authored. Commit regenerated artifacts alongside source changes. TypeDoc validates comment syntax and links; generation fails on warnings.

Run `npm run docs:check` to validate source regions, metadata, complete explanations, local links, generated artifact consistency, and the VitePress build. Check mode compares outputs without rewriting them. Use `npm run docs:dev` to read the site locally. Static output is `apps/docs/.vitepress/dist`; `npm run site:build` combines it with the demo in root `dist`, with documentation under `/docs/`. The [deployment guide](guides/deployment.md) explains the Render build settings and rewrites for `/docs` and `/docs/`.

## Visual inspection

```bash
npm run preview -- --example fireworks --backend webgl --frames 6 --interval 20 --warmup 60 --delta-time 0.0166667 --width 800 --height 600 --output ./previews/fireworks
npm run preview -- --example fire --backend webgpu --output ./previews/fire-webgpu
npm run preview -- --example collision --scene 'Collision (builtin/Octree)' --backend webgl
```

The preview builds and serves the production demo from an isolated temporary directory with Puppeteer, reusing the benchmark infrastructure and Vite configuration. Concurrent preview processes keep separate build assets. Build packages first. If Puppeteer's browser is missing, install it with `npx puppeteer browsers install chrome`. It captures PNGs directly from the rendering canvas, labels a contact sheet with fixed simulation times, and writes diagnostics to metadata.json even on runtime failure. Backend unavailability is a failure and never triggers a silent fallback.

Inspect the contact sheet after changing effect configuration. Try longer warmup for delayed emission and shorter intervals for flashes. For elevated fireworks, use `--camera-position 8,15,32 --camera-target 0,12,0`; camera settings and `--camera-fov` are recorded in metadata. A neutral scene is the default; select a demo scene to validate geometry-dependent effects. Preview output is ignored by git. `npm run preview:smoke` exercises representative sprite and mesh examples on both backends without pixel-perfect snapshots; it is an optional CI workflow because renderer availability and costs vary.

## Review

Include the example checklist in pull requests adding or substantially changing presets. Describe relevant test and preview results. Report benchmark impact for performance changes. Package publishing and documentation deployment have separate workflows. See the [deployment guide](guides/deployment.md) for Render configuration.


## Author credits and generated posters

Keep author attribution in the existing factory's literal `.author` assignment (a GitHub
username or an object with `name` and optional `url`). `<ExampleAttribution />` resolves that
source at build time; changing the author updates the site and generated agent Markdown.
Use `<ExamplePreview />` for the generated poster without copying its URL into authored prose.

After adding or changing an example, run `npm run docs:generate`. It automatically builds the
local packages and captures missing or stale example images; unchanged images are reused.
Install Chrome once with `npx puppeteer browsers install chrome` if needed.
Review and commit each generated PNG and the source-hash manifest in `apps/docs/public/previews`.
Capture defaults and scene/camera overrides live in `scripts/docs/preview-settings.json`.
`docs:check` rejects missing, modified, or stale images without requiring a browser in CI.

The canonical agent installation guide is [AI Coding Assistants](guides/ai-coding-assistants.md).
It supplies generated README guidance blocks. The full skill stays in `.agents/skills/rzmps`;
only the short template-derived `AGENTS.md` is included in npm. Run `npm run agents:check`
to validate format, reference links, temporary skill installs, and package contents.
