import { defineConfig } from 'vitepress';
import { docsUrl } from '../../../scripts/docs/site.mjs';
import path from 'node:path';
import { discoverExamples, resolveExample } from '../../../scripts/docs/examples.mjs';
import { guideNavigation } from '../../../scripts/docs/navigation.mjs';
import examples from './examples.generated.json';
import apiSections from './api.generated.json';
const hostname = docsUrl.replace(/\/$/, '');
const guideSidebar = guideNavigation(path.resolve(import.meta.dirname,'../guides')).map(({text,items})=>({text,items}));
const apiSidebar = apiSections.map(({text,items},index)=>({
  text,collapsed:index>0,
  items:items.map(item=>item.items?{...item,collapsed:true}:item),
}));
export default defineConfig({
  title: 'RZMPS',
  description: 'Modular particle effects for Three.js',
  srcExclude: ['public/**'],
  base: new URL(docsUrl).pathname,
  sitemap: { hostname: docsUrl },
  head: [['meta', {name:'theme-color',content:'#3451b2'}], ['link', {rel:'icon',type:'image/png',href: `${new URL(docsUrl).pathname}favicon.png`}]],
  transformHead: ({ pageData }) => [['link', { rel:'canonical', href:`${hostname}/${pageData.relativePath.replace(/\.md$/,'.html')}` }]],
  transformPageData(pageData) { pageData.frontmatter.lastUpdated = false; },
  vite: {
    server: { port: 5174, strictPort: true },
    plugins: [{
      name: 'rzmps-source-regions',
      enforce: 'pre',
      configureServer(server) {
        const base = new URL(docsUrl).pathname;
        server.middlewares.use((req, _res, next) => {
          const url = new URL(req.url || '/', 'http://localhost');
          if (url.pathname === base.slice(0, -1)) req.url = base + url.search;
          next();
        });
      },
      transform(code, id) {
        if (!id.endsWith('.md') || !code.includes('<ExampleCode') || !/^example: /m.test(code)) return;
        const exampleId = code.match(/^example: ([\w-]+)$/m)?.[1];
        const example = discoverExamples().find(e=>e.id===exampleId);
        if (!example) throw new Error(`Unknown example: ${id}`);
        this.addWatchFile(path.resolve(import.meta.dirname, '../../../examples', example.file));
        return resolveExample(code, example);
      },
    }],
  },
  themeConfig: {
    siteTitle: 'RZMPS',
    search: { provider: 'local' },
    nav: [
      { text:'Getting Started', link:'/guides/first-particle-system' },
      { text:'Guides', link:'/guides/' },
      { text:'API Reference', link:'/api/' },
      { text:'Examples', link:'/examples/' },
      { text:'AI Assistants', link:'/guides/ai-coding-assistants' },
      { text:'Contributing', link:'/contributing' },
    ],
    sidebar: {
      '/api/': [{text:'API Reference',link:'/api/'},...apiSidebar],
      '/': [
        {text:'Guide Overview',link:'/guides/'},
        ...guideSidebar,
        {text:'API Reference',link:'/api/'},
        {text:'Examples',collapsed:true,items:examples.map(e=>({text:e.title,link:`/examples/${e.id}`}))},
        {text:'Contributing',link:'/contributing'},
      ],
    },
    socialLinks: [{icon:'github',link:'https://github.com/rzmay/rzmps'}],
  },
});
