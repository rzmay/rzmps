import { docsUrl, demoUrl } from './site.mjs';
import { previewDefaults } from './preview-settings.mjs';
import { containers } from '../preview/media.mjs';

/** @typedef {import('vitepress').HeadConfig} HeadConfig */

export const siteDescription = 'Modular particle effects for Three.js, with interactive WebGL and WebGPU examples.';
const escapeHTML = value =>
  String(value).replace(
    /[&<>"']/g,
    character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );

/** @returns {HeadConfig[]} */
function socialMetadata({ title, description, canonical, image, width, height }) {
  return [
    ['link', { rel: 'canonical', href: canonical }],
    ['meta', { name: 'description', content: description }],
    ...Object.entries({
      'og:type': 'website',
      'og:site_name': 'RZMPS',
      'og:url': canonical,
      'og:title': title,
      'og:description': description,
      'og:image': image,
      'og:image:secure_url': image,
      'og:image:type': 'image/png',
      'og:image:alt': title,
      'og:image:width': String(width),
      'og:image:height': String(height),
    }).map(/** @returns {HeadConfig} */ ([property, content]) => ['meta', { property, content }]),
    ...Object.entries({
      'twitter:card': 'summary_large_image',
      'twitter:title': title,
      'twitter:description': description,
      'twitter:image': image,
      'twitter:image:alt': title,
    }).map(/** @returns {HeadConfig} */ ([name, content]) => ['meta', { name, content }]),
  ];
}

/** @returns {HeadConfig[]} */
export function exampleSEO(example) {
  const settings = { ...previewDefaults, ...example.previewSettings };
  const canonical = new URL(`examples/${example.id}.html`, docsUrl).href;
  const video = new URL(`previews/${example.id}.${settings.format}`, docsUrl).href;
  return [
    ...socialMetadata({
      title: example.title,
      description: example.description,
      canonical,
      image: new URL(`previews/${example.id}.png`, docsUrl).href,
      width: settings.width,
      height: settings.height,
    }),
    ...Object.entries({
      'og:video': video,
      'og:video:secure_url': video,
      'og:video:type': containers[settings.format].mime,
      'og:video:width': String(settings.width),
      'og:video:height': String(settings.height),
    }).map(/** @returns {HeadConfig} */ ([property, content]) => ['meta', { property, content }]),
  ];
}

/** @returns {HeadConfig[]} */
export function pageSEO({ title, description = siteDescription, canonical }) {
  return socialMetadata({
    title,
    description,
    canonical,
    image: new URL('previews/fire.png', docsUrl).href,
    width: previewDefaults.width,
    height: previewDefaults.height,
  });
}

/** @returns {HeadConfig[]} */
export function documentationSEO(page) {
  const route = page.relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '.html');
  return pageSEO({
    title: page.title || 'RZMPS',
    description: page.description || siteDescription,
    canonical: new URL(route, docsUrl).href,
  });
}

/** Include the unique demo homepage, while docs remain canonical for each example. */
export function sitemapItems(items) {
  return [{ url: demoUrl }, ...items.filter(item => item.url !== '404.html')];
}

/** Static demo aliases need metadata before React runs, including for social crawlers. */
export function demoPageHTML(html, example) {
  const title = example ? `${example.title} — RZMPS Demo` : 'RZMPS — Three.js Particle System Examples';
  const head = example ? exampleSEO(example) : pageSEO({ title, canonical: demoUrl });
  const tags = head
    .map(
      ([tag, attributes]) =>
        `<${tag} ${Object.entries(attributes)
          .map(([key, value]) => `${key}="${escapeHTML(value)}"`)
          .join(' ')}>`,
    )
    .join('\n');
  return html
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, '')
    .replace(/<meta\b(?=[^>]*\b(?:name|property)=["'](?:description|og:[^"']+|twitter:[^"']+)["'])[^>]*>/gi, '')
    .replace(/<link\b(?=[^>]*\brel=["']canonical["'])[^>]*>/gi, '')
    .replace(/<head\b[^>]*>/i, match => `${match}\n<title>${escapeHTML(title)}</title>\n${tags}`);
}
