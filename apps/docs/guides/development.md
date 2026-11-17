# Local Development

Clone the repository and install dependencies:

```bash
git clone https://github.com/rzmay/rzmps.git
cd rzmps
npm install
```

Run the demo and documentation together, with package watchers:

```bash
npm run dev
```

The command generates documentation sources and builds packages once, then runs package
watchers and serves the demo at `http://localhost:5173/` with docs at `/docs/`. It does not
capture preview media. `npm run generate --workspace @rzmps/docs` generates source docs;
`npm run generate:previews --workspace @rzmps/docs` separately captures missing or stale media.
Preview files under `apps/docs/public/previews/` are ignored and reused while their hashes match.
Deployment installs Chrome and FFmpeg, generates captures and validates them. Source CI needs
neither media nor a GPU. See the [automation workspace](https://github.com/rzmay/rzmps/blob/HEAD/scripts/README.md)
for individual processes and Linux capture diagnostics.

Build the core package:

```bash
npm run build --workspace packages/rzmps
```

Run the package in watch mode:

```bash
npm run dev --workspace packages/rzmps
```

Run the demo locally:

```bash
npm run dev --workspace demo
```

Build the demo:

```bash
npm run build --workspace apps/demo
```

Build the physics extensions:

```bash
npm run build --workspace @rzmps/rapier
npm run build --workspace @rzmps/jolt
npm run build --workspace @rzmps/ammo
```

Build all publishable packages:

```bash
npm run build
```

Run discovered workspace tests (or reuse a prior build):

```bash
npm test
npm test -- --skip-build
npm test -- --skip-build --set benchmarks
```

Tests stay with their app/package under `tests/`; root checks cover shared automation and
integration. The root runner gathers them automatically. Browser and generated-artifact suites
are selected separately because they need Chrome or prepared output. See the
[test workspace](https://github.com/rzmay/rzmps/blob/HEAD/tests/README.md) for suffixes and selection rules.

Run the reported browser benchmarks, or inspect another set without measuring:

```bash
npm run benchmarks -- --set reported
npm run benchmarks -- --set full --list
npm run benchmarks -- --set pr --backend gpu --split --simulation-clock fixed
```

Benchmark runs disable browser frame-rate limiting by default; add `--vsync` to measure
refresh-rate-bound behavior. Generated artifacts live in ignored `benchmarks/output/<set>/`.
Update README tables from an already measured reported artifact:

```bash
npm run update-report --workspace @rzmps/benchmarks
```

This consumer does not rerun benchmarks. The [benchmark workspace](https://github.com/rzmay/rzmps/blob/HEAD/benchmarks/README.md)
documents definitions, feature/CPU/GPU categories, shared JSON settings and PR comparison orchestration.
