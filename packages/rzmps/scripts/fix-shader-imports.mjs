import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(__dirname, '../build');

async function processDirectory(directory)
{
    let entries;

    try
    {
        entries = await fs.readdir(directory, {
            withFileTypes: true,
        });
    }
    catch (error)
    {
        if (error.code === 'ENOENT')
            return;

        throw error;
    }

    await Promise.all(entries.map(async (entry) =>
    {
        const entryPath = path.join(directory, entry.name);

        if (entry.isDirectory())
        {
            await processDirectory(entryPath);
            return;
        }

        if (!entry.name.endsWith('.js'))
            return;

        let source = await fs.readFile(entryPath, 'utf8');

        source = source
            .replaceAll(/(\.vert)(['"])/g, '$1.js$2')
            .replaceAll(/(\.frag)(['"])/g, '$1.js$2');

        await fs.writeFile(entryPath, source, 'utf8');
    }));
}

await processDirectory(buildDir);
