# Shared examples

`presets/` contains particle-system factories; `scenes/` contains scene factories. Both indexes discover factories
and their `factory.metadata` automatically. The demo and docs consume these same sources. Shared media belongs in
`assets/`; scene infrastructure and UI helpers may share code from `utils/`.

## Presets teach construction from scratch

Keep every particle preset self-contained. Its RZMPS configuration, texture/material setup, local helpers and
subsystems belong in the preset itself. Do not import another preset or extract its configuration into an
example-specific helper. A reader should understand the complete construction from that preset's generated docs.
Imports from RZMPS, Three.js, normal external dependencies and media assets are welcome.

Scene factories may be imported for `factory.metadata.previewSettings.scene` so the demo and captures can choose a
preferred environment; do not call scene factories or helpers from the particle factory. Scene code, UI integration
and non-preset infrastructure may continue sharing helpers.

Use a named default factory such as `acidPreset` or `checkerboardScene`. Preserve the return contract and literal
`factory.metadata` author, ID, title, description and tags. Set preview overrides in metadata and omit defaults.
Use workspace paths such as `examples/assets/images/smoke.png?url` or `examples/scenes/checkerboard.js`.

Mark the actual configuration with balanced `docs:system`, `docs:emitters`, `docs:modules` and `docs:renderers` source
regions. Include material/texture setup and local helper definitions that the example needs; named suffixes can
separate root and child systems. Authored guides reference these regions with `<ExampleCode region="system" />`
and equivalent component blocks. These are extraction categories, not required article headings.
Organize explanations around the effect's design intentions, and do not paste a second implementation into Markdown.
See [Writing Example Guides](../apps/docs/README.md#writing-example-guides) for readable curves, code style and walkthroughs.

## Validation

From the repository root:

```bash
npm run lint
node --test apps/docs/tests/examples.test.mjs examples/tests/catalog.test.mjs
npm run scripts check:source
```

Self-contained presets are a contributor design guideline. Existing documentation checks validate metadata, balanced
source regions and source-linked explanations; no additional import-policy CI gate is imposed.

After editing, regenerate docs and the published skill with `npm run generate --workspace @rzmps/docs`, and run `npm run scripts check:docs`
before opening a PR. See [the contributor guide](../CONTRIBUTING.md) for architecture, filenames, API input types,
WebGL/WebGPU validation and generated-file policy.
