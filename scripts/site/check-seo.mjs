import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverExamples } from '../docs/examples.mjs';
import { demoUrl, docsUrl } from '../docs/site.mjs';
import { exampleSEO, pageSEO } from '../docs/seo.mjs';

const decode = text =>
  text.replace(
    /&(amp|lt|gt|quot|#39);/g,
    (_match, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity],
  );
function checkHead(html, expected, label, title) {
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1];
  if (!head || !/<title>[^<]+<\/title>/i.test(head)) throw new Error(`${label}: missing HTML title/head`);
  const actualTitle = decode(head.match(/<title>([^<]+)<\/title>/i)[1]);
  if (actualTitle !== title && !actualTitle.startsWith(`${title} | `) && !actualTitle.startsWith(`${title} — `))
    throw new Error(`${label}: incorrect HTML title`);
  const tags = [...head.matchAll(/<(meta|link)\b([^>]+)>/gi)].map(([, tag, attributes]) => ({
    tag: tag.toLowerCase(),
    attributes: Object.fromEntries(
      [...attributes.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(([, key, double, single]) => [
        key,
        decode(double ?? single),
      ]),
    ),
  }));
  for (const [tag, attributes] of expected) {
    const key = tag === 'link' ? 'rel' : attributes.property ? 'property' : 'name';
    const matches = tags.filter(entry => entry.tag === tag && entry.attributes[key] === attributes[key]);
    if (
      matches.length !== 1 ||
      Object.entries(attributes).some(([name, value]) => matches[0]?.attributes[name] !== value)
    )
      throw new Error(`${label}: missing, duplicate or incorrect ${attributes[key]}`);
  }
}

/** Validate the actual deployment, including social metadata targets, without a browser or media encoding. */
export async function checkSiteSEO(
  directory = path.resolve(import.meta.dirname, '../../dist'),
  examples = discoverExamples(),
) {
  const robots = await fs.readFile(path.join(directory, 'robots.txt'), 'utf8');
  const sitemapURL = new URL('sitemap.xml', docsUrl).href;
  if (!robots.split(/\r?\n/).some(line => line.trim() === `Sitemap: ${sitemapURL}`))
    throw new Error('robots.txt: missing canonical documentation sitemap');
  const sitemap = await fs.readFile(path.join(directory, 'docs/sitemap.xml'), 'utf8');
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => decode(match[1]));
  for (const url of [
    demoUrl,
    docsUrl,
    ...examples.map(example => new URL(`examples/${example.id}.html`, docsUrl).href),
  ])
    if (!locations.includes(url)) throw new Error(`Sitemap is missing ${url}`);
  checkHead(
    await fs.readFile(path.join(directory, 'index.html'), 'utf8'),
    pageSEO({ title: 'RZMPS — Three.js Particle System Examples', canonical: demoUrl }),
    'Demo homepage',
    'RZMPS — Three.js Particle System Examples',
  );
  for (const example of examples) {
    const expected = exampleSEO(example);
    for (const file of [
      `docs/examples/${example.id}.html`,
      `example/${example.id}/index.html`,
      `example/${example.id}.html`,
    ])
      checkHead(await fs.readFile(path.join(directory, file), 'utf8'), expected, file, example.title);
    for (const property of ['og:image', 'og:video']) {
      const url = new URL(expected.find(([, attrs]) => attrs.property === property)[1].content);
      if (url.origin !== new URL(docsUrl).origin) throw new Error(`${example.id}: unexpected ${property} origin`);
      const file = path.join(directory, decodeURIComponent(url.pathname));
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile() || !stat.size) throw new Error(`${example.id}: missing or empty ${property} asset: ${file}`);
    }
  }
  return examples.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const count = await checkSiteSEO(process.argv[2]);
  console.log(`Validated robots, sitemap, canonical/social metadata and media targets for ${count} examples.`);
}
