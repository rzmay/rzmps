import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { createSiteServer } from './serve.mjs';
import { discoverExamples } from '../docs/examples.mjs';
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
  const skill=await fetch(origin+'/docs/agent-skill/SKILL.md');assert.equal(skill.status,200);assert.match(await skill.text(),/^---\nname: rzmps/);
  for(const url of ['/llms.txt','/llms-full.txt'])assert.equal((await fetch(origin+url)).status,200,url);
  assert.deepEqual(errors,[]);
  console.log('All 20 example posters, author credits, hosted skill, and discovery files passed browser checks.');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
