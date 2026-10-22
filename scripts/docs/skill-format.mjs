import fs from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
export function validateSkill(skillPath, generated = new Map()) {
  const read = file => generated.get(file) ?? fs.readFileSync(file,'utf8');
  const source = read(skillPath);
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`${skillPath}: missing YAML frontmatter`);
  const parsed = parseDocument(match[1]);
  if (parsed.errors.length) throw new Error(`${skillPath}: invalid YAML: ${parsed.errors[0].message}`);
  const metadata = parsed.toJS();
  if (metadata?.name !== 'rzmps' || metadata.name.length > 64) throw new Error('Skill name must match the rzmps directory');
  if (typeof metadata.description !== 'string' || !metadata.description.trim() || metadata.description.length > 1024) throw new Error('Skill needs a descriptive summary of at most 1024 characters');
  for (const term of ['Three.js','particle systems','VFX','emitters','modules','renderers','WebGL','WebGPU']) if (!metadata.description.toLowerCase().includes(term.toLowerCase())) throw new Error(`Skill description is missing ${term}`);
  if (/\[TODO|TODO:/.test(source)) throw new Error('Skill contains unfinished scaffold text');
  const directory = path.dirname(skillPath);
  const files = new Set([skillPath]);
  if (fs.existsSync(directory)) {
    const visit = dir => fs.readdirSync(dir,{withFileTypes:true}).forEach(e => e.isDirectory() ? visit(path.join(dir,e.name)) : e.name.endsWith('.md') && files.add(path.join(dir,e.name)));
    visit(directory);
  }
  for (const file of generated.keys()) if (file.startsWith(directory+path.sep) && file.endsWith('.md')) files.add(file);
  for (const file of files) {
    // In check mode stale generated files are diagnosed by the generator, not treated as canonical inputs.
    if (generated.size && file !== skillPath && !generated.has(file)) continue;
    const markdown = read(file).replace(/```[\s\S]*?```/g,'');
    for (const [,href] of markdown.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(https?:|mailto:|data:|#)/.test(href)) continue;
      const target = path.resolve(path.dirname(file),decodeURIComponent(href.split('#')[0]));
      if (!target.startsWith(directory+path.sep) || (!generated.has(target) && !fs.existsSync(target))) throw new Error(`${file}: invalid skill reference ${href}`);
    }
  }
  return metadata;
}
