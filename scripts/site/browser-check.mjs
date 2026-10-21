import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { createSiteServer } from './serve.mjs';
import { discoverExamples } from '../docs/examples.mjs';

async function checkAttributionAlignment(page) {
  assert.ok(await page.evaluate(() => {
    const viewport = document.querySelector('.demo-shell').getBoundingClientRect();
    const center = viewport.left + viewport.width / 2;
    return [...document.querySelectorAll('.preset-attribution > div')].every(element => {
      const bounds = element.getBoundingClientRect();
      return Math.abs(bounds.left + bounds.width / 2 - center) < 1;
    });
  }), 'description, credits, and links share the example viewport center');
}

const server=createSiteServer();
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser=await puppeteer.launch({headless:true,args:process.env.CI==='true'?['--no-sandbox','--disable-setuid-sandbox']:[],defaultViewport:{width:1200,height:1000}});
  const page=await browser.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('response',response=>{if(response.status()>=400)errors.push(`${response.status()} ${response.url()}`);});
  const demoResponse=await page.goto(origin+'/',{waitUntil:'networkidle0'});
  assert.equal(demoResponse.status(),200);
  assert.equal(new URL(page.url()).pathname,'/','root must remain the demo after hydration');
  await page.waitForSelector('canvas');
  assert.ok(await page.$('a[href="/docs/"]'),'demo links to documentation');
  const sidebar = '#landing-sidebar';
  const toggle = '.sidebar-toggle';
  await page.waitForSelector(sidebar, { visible: true });
  assert.equal(await page.$eval(toggle, element => element.getAttribute('aria-expanded')), 'true');
  assert.match(await page.$eval('.landing-version', element => element.textContent), /^v\d+\.\d+\.\d+/);
  await page.evaluate(() => document.fonts.ready);
  assert.ok(await page.$eval('.landing-heading', element => {
    const brand = element.querySelector('.landing-brand').getBoundingClientRect();
    const version = element.querySelector('.landing-version').getBoundingClientRect();
    return version.left >= brand.right && version.top < brand.bottom;
  }), 'version is inline with the header');
  await page.setViewport({ width: 1366, height: 720 });
  assert.ok(await page.$eval(sidebar, element => element.scrollHeight <= element.clientHeight), 'sidebar fits a standard laptop screen without scrolling');
  await checkAttributionAlignment(page);
  const initialCanvas = await page.$('.demo-shell canvas');
  await page.waitForFunction(() => document.querySelector('.demo-shell canvas').getBoundingClientRect().width === innerWidth);
  const motion = await page.evaluate(async () => {
    const panel = document.querySelector('#landing-sidebar');
    const canvas = document.querySelector('.demo-shell canvas');
    const panelWidth = panel.getBoundingClientRect().width;
    const initialWidth = canvas.width;
    const frames = [];
    document.querySelector('.sidebar-toggle').click();
    const start = performance.now();
    do {
      await new Promise(requestAnimationFrame);
      const bounds = canvas.getBoundingClientRect();
      frames.push({
        edge: panel.getBoundingClientRect().right,
        fps: document.querySelector('.demo-stats').getBoundingClientRect().left,
        count: document.querySelector('.particle-count-monitor').getBoundingClientRect().left,
        canvasCentered: bounds.left === 0 && bounds.width === innerWidth && canvas.width === initialWidth,
      });
    } while (performance.now() - start < 300);
    return { panelWidth, frames };
  });
  assert.ok(motion.frames.some(frame => frame.edge > 1 && frame.edge < motion.panelWidth - 1), 'sidebar slides through intermediate positions');
  assert.ok(motion.frames.every(frame => frame.canvasCentered), 'canvas position and resolution stay fixed throughout the slide');
  assert.ok(motion.frames.every(frame => Math.abs(frame.fps - frame.edge) < 1 && Math.abs(frame.count - frame.edge) < 1), 'both monitors follow the sidebar edge throughout the slide');
  await page.waitForSelector(sidebar, { hidden: true });
  assert.ok(await initialCanvas.evaluate(element => element === document.querySelector('.demo-shell canvas')), 'toggling preserves the canvas');
  assert.ok(await page.$eval(sidebar, element => element.inert), 'collapsed sidebar cannot receive focus');
  await checkAttributionAlignment(page);
  await page.evaluate(() => localStorage.setItem('rzmps:landing-sidebar', 'closed'));
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector(sidebar, { visible: true });
  assert.equal(await page.$eval(toggle, element => element.getAttribute('aria-expanded')), 'true', 'each load opens the sidebar, including with a previously saved closed preference');
  await page.focus(`${sidebar} a`);
  await page.keyboard.press('Escape');
  await page.waitForSelector(sidebar, { hidden: true });
  assert.ok(await page.$eval(toggle, element => element === document.activeElement), 'Escape restores focus');
  await page.setViewport({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector(sidebar, { visible: true });
  assert.ok(await page.$eval(sidebar, element => element.getBoundingClientRect().right <= innerWidth), 'mobile sidebar fits viewport');
  assert.ok(await page.$eval('.demo-stats', element => element.getBoundingClientRect().right <= innerWidth), 'mobile FPS monitor remains within the viewport');
  assert.ok(await page.$eval('.particle-count-monitor', element => element.getBoundingClientRect().right <= innerWidth), 'mobile particle monitor remains within the viewport');
  await page.waitForFunction(() => document.elementFromPoint(40, 40)?.closest('#landing-sidebar'), { timeout: 5000 });
  await page.setViewport({ width: 390, height: 480 });
  assert.ok(await page.$eval(sidebar, element => element.scrollHeight > element.clientHeight), 'short viewports can scroll through resources');
  await page.keyboard.press('Escape');
  await page.waitForSelector(sidebar, { hidden: true });
  await checkAttributionAlignment(page);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.focus(toggle);
  await page.keyboard.press('Enter');
  await page.waitForSelector(sidebar, { visible: true });
  assert.ok(await page.$eval(sidebar, element => getComputedStyle(element).transitionDuration.split(',').every(duration => parseFloat(duration) === 0)), 'reduced motion disables the slide');
  await page.emulateMediaFeatures([]);
  await page.setViewport({ width: 1200, height: 1000 });
  console.log('Landing sidebar: default visibility, compact layout, inline version, keyboard controls, and mobile layout passed');
  console.log('/: interactive demo rendered without redirecting to docs');
  for(const entry of ['/docs','/docs/']){
    const response=await page.goto(origin+entry,{waitUntil:'networkidle0'});
    assert.equal(response.status(),200,entry);
    assert.equal(await page.$eval('main h1',element=>element.textContent.replace(/\u200b/g,'').trim()),'🧅 RZMPS',entry);
    assert.match(await page.title(),/🧅 RZMPS/);
    console.log(`${entry}: rendered and hydrated documentation homepage`);
  }
  for(const example of discoverExamples()){
    await page.goto(`${origin}/docs/examples/${example.id}.html`,{waitUntil:'networkidle0'});
    const poster=await page.$('.vp-doc img[src*="/previews/"]');
    assert.ok(poster,`${example.id}: preview image`);
    await poster.evaluate(element=>element.scrollIntoView());
    await page.waitForFunction(()=>{const image=document.querySelector('.vp-doc img[src*="/previews/"]');return image.complete&&image.naturalWidth>0;});
    assert.equal(await poster.evaluate(element=>new URL(element.src).pathname),`/docs/previews/${example.id}.png`);
    const text=await page.$eval('.vp-doc',element=>element.textContent);
    assert.ok(text.includes(`Preset by ${example.author.name}`),`${example.id}: credit`);
  }
  assert.equal((await fetch(origin+'/docs/agent-skill/SKILL.md')).status,404,'the documentation must not host a duplicate skill');
  const discovery=await fetch(origin+'/llms.txt');assert.equal(discovery.status,200);
  const discoveryText=await discovery.text();
  assert.ok(discoveryText.includes('npx skills add rzmay/rzmps --skill rzmps'));
  assert.ok(discoveryText.includes('https://github.com/rzmay/rzmps/tree/HEAD/.agents/skills/rzmps'));
  for(const url of ['/llms.txt','/llms-full.txt'])assert.equal((await fetch(origin+url)).status,200,url);
  assert.deepEqual(errors,[]);
  console.log('All 20 example posters, author credits, GitHub skill discovery guidance, and discovery files passed browser checks.');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
