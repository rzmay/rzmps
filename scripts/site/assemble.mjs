import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(import.meta.dirname,'../..');
export async function assembleSite({ demoDirectory=path.join(root,'apps/demo/dist'), docsDirectory=path.join(root,'apps/docs/.vitepress/dist'), output=path.join(root,'dist') }={}) {
  for(const input of [demoDirectory,docsDirectory])await fs.access(path.join(input,'index.html'));
  for(const input of [root,demoDirectory,docsDirectory])if(path.resolve(output)===path.resolve(input))throw new Error('Combined output must be separate from the repository and input directories');
  await fs.rm(output,{recursive:true,force:true});
  await fs.mkdir(output,{recursive:true});
  await fs.cp(demoDirectory,output,{recursive:true});
  await fs.cp(docsDirectory,path.join(output,'docs'),{recursive:true});
  // A physical alias also supports static hosts that resolve /docs to /docs.html.
  await fs.copyFile(path.join(docsDirectory,'index.html'),path.join(output,'docs.html'));
  for(const file of ['llms.txt','llms-full.txt'])await fs.copyFile(path.join(docsDirectory,file),path.join(output,file));
  console.log(`Combined static site: ${output} (demo at /, documentation at /docs and /docs/)`);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await assembleSite();
