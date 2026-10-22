import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assembleSite } from './assemble.mjs';
import { createSiteServer } from './serve.mjs';
test('one static output serves demo and both docs entry paths, assets and deep links',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'rzmps-site-test-'));
  let server;
  try {
    const demoDirectory=path.join(temp,'demo'),docsDirectory=path.join(temp,'documentation'),output=path.join(temp,'site');
    await fs.mkdir(demoDirectory);await fs.mkdir(path.join(docsDirectory,'guides'),{recursive:true});
    await fs.mkdir(path.join(docsDirectory,'previews'));
    for(const [file,body]of [['index.html','demo'],['asset.js','demo asset']])await fs.writeFile(path.join(demoDirectory,file),body);
    for(const [file,body]of [['index.html','🧅 docs'],['guides/start.html','guide'],['previews/fire.png','PNG'],['llms.txt','discovery'],['llms-full.txt','full docs']])await fs.writeFile(path.join(docsDirectory,file),body);
    await assembleSite({demoDirectory,docsDirectory,output});
    server=createSiteServer(output);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    for(const [url,body]of [['/','demo'],['/docs','🧅 docs'],['/docs/','🧅 docs'],['/docs?x=1','🧅 docs'],['/docs/guides/start','guide'],['/docs/guides/start.html','guide'],['/docs/previews/fire.png','PNG'],['/llms.txt','discovery'],['/docs/llms-full.txt','full docs']]){
      const response=await fetch(origin+url,{redirect:'manual'});assert.equal(response.status,200,url);assert.equal(response.headers.get('location'),null,url);assert.equal(await response.text(),body,url);
    }
    assert.equal((await fetch(origin+'/docs/absent')).status,404);
    assert.equal((await fetch(origin+'/docs/previews/missing.png')).status,404);
  } finally {if(server)await new Promise(resolve=>server.close(resolve));await fs.rm(temp,{recursive:true,force:true});}
});
