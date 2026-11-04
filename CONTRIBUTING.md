# Contributing to 🧅 RZMPS

The canonical contributor guide is [apps/docs/contributing.md](apps/docs/contributing.md).
It covers shared examples, source regions, authored explanations, TSDoc, generated agent
references, checks, and WebGL/WebGPU preview commands.

Start with `npm install`, `npm run build:modules`, and `npm test`.
Run `npm run docs:generate` after documentation or example changes and `npm run docs:check`
before submitting a pull request. Generated files carry a notice; authored guides are preserved.

Prepare your current working tree for a PR targeting `develop` with:

```bash
npm run pr:prepare
```

This runs the core tests, builds all packages, regenerates the published benchmark
reports in the READMEs, generates and validates documentation, and builds the demo.
It stops at the first failure and checks staged and unstaged whitespace at the end.
Install the browser once with `npx puppeteer browsers install chrome`.

Review and commit the updated README benchmark tables, generated documentation, and
`apps/docs/public/previews/` images and manifest with your source changes. CI and deployment
validate committed previews and reject missing or stale captures without launching Chrome. The GitHub runner's cross-branch PR benchmarks remain a
separate, unchanged process. This command does not create local PR comparison results.

See the [code of conduct](.github/CODE_OF_CONDUCT.md).
