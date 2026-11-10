# SEO and preview audit

The example metadata is authoritative. Categories have been folded into tags,
following the later UI revision. Published example IDs and documentation URLs
remain stable despite preset filename changes.

| Requirement | Implementation and checks |
| --- | --- |
| Crawling and sitemap | Root `apps/demo/public/robots.txt` permits crawling and advertises `/docs/sitemap.xml`. VitePress generates the sitemap with its `/docs/` hostname; it includes every example and the unique demo homepage. |
| Canonical pages | Example documentation is canonical. Static `/example/<id>` aliases use the documentation canonical; index-page canonicals use trailing-slash URLs matching the sitemap. |
| Titles and descriptions | VitePress derives example titles/descriptions from metadata. Site assembly writes homepage and per-example demo metadata into static HTML, before JavaScript executes. |
| Open Graph and Twitter/X | Absolute canonical, poster and video URLs; title, description, image MIME/dimensions/alt text, video MIME/dimensions, and a static-poster Twitter card. Other documentation pages get canonical/social metadata too. |
| Video encoding | Existing FFmpeg pipeline uses CRF, H.264/MP4 or VP9/WebM, browser-compatible yuv420p, and MP4 fast-start. Configurable fps and resolution reduce output size without another optimizer. |
| PNG optimization | FFmpeg retains a full-resolution poster using lossless PNG compression level 9. |
| Capture timing and audio | Frames stream to temporary files; simulation time controls capture cadence. Audio uses a synchronized offline mix, encoded to AAC or Opus. |
| WebGPU | Pinned Puppeteer/Chrome, explicit software-adapter CI flags, render-target readback, asynchronous shader compilation and GPU synchronization. Failures preserve diagnostics; WebGPU never falls back silently. |
| Lazy playback and accessibility | Native controls and poster, muted looping inline playback, no autoplay or media fetch until onscreen, reduced-motion opt-out, and pause when offscreen. |
| Asset lifecycle | Ignored, untracked media; input/tool-version hashes; deployment cache restoration; only stale entries regenerate. Explicit preview/deployment commands own capture. Ordinary docs/source validation requires no generated media. |
| Asset validation | Existing checks validate hashes, backend, dimensions, fps/duration, decoding and nonuniform image content. Deployment checks both original and assembled preview outputs. |
| Discovery | Sidebar combobox and VitePress index use preset metadata. Tags/descriptions/authors are indexed, result titles exclude presentation markup, and metadata changes refresh the development index. |
| Deployment SEO gate | `scripts/site/check-seo.mjs` validates assembled robots/sitemap entries, HTML titles, canonical/social metadata on docs and demo aliases, and local media targets. `site:deploy` runs it after media validation. |

The focused tests use synthetic media, an isolated browser player, actual
VitePress search indexing, actual WebGPU pixel readback, and temporary static-site
fixtures. This audit does not regenerate all production media, build all docs, or
publish a deployment. Public URL availability and the complete Linux deployment
remain the deployment job's responsibility.

References:

- [Open Graph protocol](https://ogp.me/)
- [Google: robots.txt location and sitemap directive](https://developers.google.com/crawling/docs/robots-txt/create-robots-txt)
- [VitePress sitemap generation](https://vitepress.dev/guide/sitemap-generation)
- [FFmpeg format options and fast-start](https://ffmpeg.org/ffmpeg-formats.html)
- [Render native build tools, including FFmpeg](https://render.com/docs/native-runtimes)
