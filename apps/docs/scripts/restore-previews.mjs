import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { docsUrl } from './site.mjs';
import { checksum, previewDirectory } from './preview-manifest.mjs';

/** Previous public deployment is an optional cache for hosts without persistent build directories. */
export async function restorePreviews({
  base = new URL('previews/', docsUrl),
  directory = previewDirectory,
  fetcher = fetch,
} = {}) {
  if (
    await fs.access(path.join(directory, 'manifest.json')).then(
      () => true,
      () => false,
    )
  )
    return;
  try {
    const get = async (name, limit) => {
      const response = await fetcher(new URL(name, base), { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${name}`);
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) throw new Error(`Cache file too large: ${name}`);
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    };
    const manifest = JSON.parse(await get('manifest.json', 2 * 1024 * 1024));
    if (!manifest.examples || Object.keys(manifest.examples).length > 100)
      throw new Error('Invalid preview cache manifest');
    await fs.mkdir(directory, { recursive: true });
    for (const entry of Object.values(manifest.examples))
      for (const [name, hash] of Object.entries(entry.files ?? {})) {
        if (!/^[\w-]+\.(png|mp4|webm)$/.test(name)) throw new Error(`Invalid cache asset name: ${name}`);
        const bytes = await get(name, 50 * 1024 * 1024);
        if (checksum(bytes) !== hash) throw new Error(`Cache checksum mismatch: ${name}`);
        await fs.writeFile(path.join(directory, name), bytes);
      }
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log('Restored preview cache from previous deployment; input hashes will be checked before reuse.');
  } catch (error) {
    console.warn(`Preview cache unavailable (${error.message}); missing assets will be regenerated.`);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await restorePreviews();
