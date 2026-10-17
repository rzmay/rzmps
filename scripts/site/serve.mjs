import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.txt':'text/plain; charset=utf-8','.md':'text/markdown; charset=utf-8','.wasm':'application/wasm','.mp3':'audio/mpeg','.wav':'audio/wav'};
export function createSiteServer(directory=path.resolve(import.meta.dirname,'../../dist')) {
  const root=path.resolve(directory);
  return http.createServer(async(req,res)=>{
    try {
      if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return;}
      let pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      if(pathname==='/docs'||pathname==='/docs/')pathname='/docs/index.html';
      const target=path.resolve(root,'.'+pathname);
      if(target!==root&&!target.startsWith(root+path.sep)){res.writeHead(404).end('Not found');return;}
      let file;
      for(const candidate of [target,target+'.html',path.join(target,'index.html')]){
        if((await fs.stat(candidate).catch(()=>null))?.isFile()){file=candidate;break;}
      }
      if(!file){res.writeHead(404).end('Not found');return;}
      res.writeHead(200,{'content-type':types[path.extname(file)]??'application/octet-stream'});
      if(req.method==='HEAD')res.end();else await pipeline(createReadStream(file),res);
    } catch(error){if(!res.headersSent)res.writeHead(error instanceof URIError?400:500);res.end();}
  });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.PORT??4173);
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('PORT must be a valid TCP port');
  const server=createSiteServer();
  server.listen(port,process.env.RENDER?'0.0.0.0':'127.0.0.1',()=>console.log(`Combined preview: http://localhost:${server.address().port}/ (docs at /docs and /docs/)`));
}
