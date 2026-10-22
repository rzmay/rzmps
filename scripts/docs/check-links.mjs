import fs from 'node:fs';
import { docsUrl } from './site.mjs';
import path from 'node:path';
const base = new URL(docsUrl).pathname;
const root = path.resolve(import.meta.dirname, '../../apps/docs/.vitepress/dist');
const files = dir => fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]);
const pages = new Map(files(root).filter(f=>f.endsWith('.html')).map(file=>[file,fs.readFileSync(file,'utf8')]));
let count=0;
for (const [file,html] of pages) {
  for (const match of html.matchAll(/<(?:a|img)\b[^>]*\b(?:href|src)="([^"]+)"/g)) {
    const href=match[1].replaceAll('&amp;','&');
    if(/^(https?:|mailto:|data:|javascript:)/.test(href))continue;
    const [rawTarget,rawHash] = href.split('#');
    const target=decodeURIComponent(rawTarget.split('?')[0]);
    if(!target&&!rawHash)continue;
    const resolved=!target?file:target.startsWith(base)?path.join(root,target.slice(base.length)):target===base.slice(0,-1)?path.join(root,'index.html'):target.startsWith('/')?path.join(root,target):path.resolve(path.dirname(file),target);
    const dest=[resolved,path.join(resolved,'index.html'),resolved+'.html'].find(f=>fs.existsSync(f)&&fs.statSync(f).isFile());
    if(!dest)throw new Error(`${path.relative(root,file)}: missing target ${href}`);
    if(rawHash&&pages.has(dest)) {
      const hash=decodeURIComponent(rawHash);
      if(!pages.get(dest).includes(`id="${hash}"`))throw new Error(`${path.relative(root,file)}: missing anchor ${href}`);
    }
    count++;
  }
}
console.log(`Validated ${count} local HTML links and anchors across ${pages.size} pages.`);

const sitemap=fs.readFileSync(path.join(root,'sitemap.xml'),'utf8');
for(const [,url] of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g))if(!url.startsWith(docsUrl))throw new Error(`Sitemap URL is outside the configured documentation base: ${url}`);
