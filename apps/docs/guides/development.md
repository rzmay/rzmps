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

The command generates the documentation sources and builds the packages, then serves
the demo at `http://localhost:5173/`. Preview images are generated while the demo is
available. Documentation starts at `http://localhost:5173/docs/` once previews finish.
During preview generation, documentation requests return a temporary 503 response.

Use `npm run docs:dev` for the same startup sequence without package watchers.
`npm run docs:generate` still generates both documentation sources and previews;
`npm run docs:generate -- --skip-previews` defers previews to `npm run docs:previews`.

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
npm start --workspace apps/demo
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
npm run build:modules
```

Run the core library regression tests:

```bash
npm test
```

The test suite lives in `packages/rzmps/tests` and focuses on behavior that is
easy to regress while optimizing internals: force application, priority phases,
depth and size mapping, distortion controls, audio effect calculations,
mutable-value isolation, and subsystem inheritance.

Run the benchmark suite and print browser-rendered results to the terminal:

```bash
npm run benchmark:run
```

Benchmark runs disable browser frame-rate limiting by default. Add `-- --vsync`
to measure refresh-rate-bound behavior instead.

Open a visible browser window while running the same benchmark:

```bash
npm run benchmark:run -- --open
```

Serve the built benchmark page for visual/manual inspection:

```bash
npm run benchmark:serve --workspace demo
```

Then open `http://127.0.0.1:4173/?benchmark=1`.

Update the benchmark report tables in the READMEs:

```bash
npm run benchmark:update-report
```

