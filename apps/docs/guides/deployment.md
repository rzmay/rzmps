# Hosting the Demo and Documentation

Run `npm run dev` from the repository root to develop the demo and documentation together.
The public development server serves the demo at `http://localhost:5173/` and proxies only
`/docs` requests to a private VitePress server. `npm run docs:dev` generates documentation first
and then starts the same combined server. Stop any previously running demo and docs servers
before starting either command.

If you run the applications separately, the demo uses port 5173 and the standalone docs server
uses port 5174 with strict port checking. Running both on port 5173 can let VitePress receive
root requests and redirect them to `/docs/`, hiding the demo. Restart old processes after
updating the configuration. VitePress's `base` controls its routes and assets; it does not mount
VitePress inside another server or configure a production host.

RZMPS now uses `/docs/` as its documentation base and `https://rzmps.rzmay.com/docs/` as its
canonical public URL, configured in `scripts/docs/site.mjs`. The local VitePress server accepts
`/docs` internally as well as `/docs/`; neither request displays Vite's base-path instruction page.

## One Render Static Deployment

Both applications produce static files. Use one Render Static Site with the repository root as
its root directory, branch `develop`, these build settings, and your existing custom domain:

| Setting | Value |
| --- | --- |
| Service type | Static Site |
| Root Directory | **Leave empty** (the repository root containing `package.json` and `render.yaml`) |
| Branch | `develop` |
| Build command | `npm ci && npm run site:build` |
| Publish directory | `dist` |
| Node version | `22` |
| `SKIP_INSTALL_DEPS` | `true` (the build command runs npm ci) |
| `PUPPETEER_SKIP_DOWNLOAD` | `true` (committed previews need no browser during deployment) |

The root `render.yaml` provides the equivalent Blueprint configuration. For an existing Render
site, apply these settings to that site; no second service or domain is needed. The build
regenerates ignored API pages, indexes, navigation data, and `llms` files from canonical sources,
checks committed skill/README outputs and preview freshness, builds both applications, and assembles:

```text
dist/
├── index.html          # Demo
├── assets/             # Demo assets
├── docs.html           # Alias for hosts supporting extensionless HTML
├── docs/
│   ├── index.html      # VitePress homepage
│   ├── assets/         # Documentation assets
│   └── previews/       # Generated example images
├── llms.txt
└── llms-full.txt
```

Do not set Root Directory to `apps/demo`, `apps/docs`, `packages/rzmps`, or a path on your local
machine. Render runs the build in its Git checkout; leaving this field empty keeps all workspace
packages available. Publish `dist`, not `apps/docs/.vitepress/dist`, which contains only the docs.

### Local Workspace Packages

Yes: this deployment builds the RZMPS source from the selected Git branch. `npm ci` at the
repository root links the matching `@rzmps/*` npm workspaces to `packages/*`. `site:build` first
runs `build:modules`, then the demo's Vite configuration aliases those imports to the local
`packages/*/build/index.mjs` files. Other dependencies still install from npm. Render serves the
resulting static bundles; no library is installed when a visitor opens the site.

Keep the demo's dependency version ranges compatible with the workspace package versions.
You can verify the current workspace links from the repository root:

```bash
node -e "console.log(require('fs').realpathSync('node_modules/@rzmps/rzmps'))"
```

The output should end in `/packages/rzmps` inside the checkout.

Configure these exact Render **rewrites**, keeping them ahead of any broad SPA fallback:

| Source | Destination | Action |
| --- | --- | --- |
| `/docs` | `/docs/index.html` | Rewrite |
| `/docs/` | `/docs/index.html` | Rewrite |

A rewrite serves the homepage content without asking the visitor to change the URL. Existing
static assets and HTML pages are served normally. The demo uses query parameters rather than
path-based SPA routes, so this configuration needs no `/*` catch-all. Avoid rewriting missing
documentation assets or unknown docs pages to the demo's index.html.
Remove any existing redirect from `/` or `/*` to `/docs/`. If `/` shows documentation in
production, check the publish directory first: the combined `dist/index.html` belongs to the demo.

See Render's [static site setup](https://render.com/docs/static-sites),
[rewrite behavior](https://render.com/docs/redirects-rewrites),
[monorepo root directories](https://render.com/docs/monorepo-support), and
[Blueprint reference](https://render.com/docs/blueprint-spec). The local server verifies the
same two entry paths; the deployment's CDN behavior can only be verified after deployment.

## Local Production Preview

```bash
npm run site:build
npm run site:preview
```

Open `http://localhost:4173/` for the demo, and either `http://localhost:4173/docs` or
`http://localhost:4173/docs/` for documentation. This serves the combined static output on a
single port. `npm run docs:dev` remains available for documentation authoring with live reload.

For an existing Render **Web Service**, the same combined directory can instead be served by
`node scripts/site/serve.mjs`; it uses Render's `PORT` and binds to all interfaces there. Keep
that option if the service also needs server-side behavior. A Static Site avoids running a
Node server when all you need is these two static frontends.

Two deployments are useful only if you want independent release schedules, separate domains,
or different access policies. DNS alone cannot mount a second deployment under `/docs`; a
shared origin would need a proxy or edge routing layer. The combined output avoids that setup.

## Example Images

`npm run docs:generate` automatically captures missing or stale preview images after updating
the example registry. Adding a preset, changing its factory, deleting or modifying its image,
or changing a shared rendering dependency triggers a fresh capture. Unchanged previews are
reused without starting a browser or rebuilding packages. When capture is needed, generation
builds the local packages and uses Puppeteer to render the actual preset.

If Chrome is missing, install it once with `npx puppeteer browsers install chrome`, then rerun
generation. Capture errors fail generation rather than leaving a successful run with missing images.
Inspect and commit `apps/docs/public/previews` with its manifest. The manifest records source
and image hashes, authoring capture settings, backend, camera, and diagnostics. Unchanged inputs
reuse existing captures; `npm run docs:previews -- --force` explicitly regenerates them.
`docs:check` and the Render build only verify committed previews, so deployment needs no browser.
