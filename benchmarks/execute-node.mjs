import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [file, output, encodedOptions] = process.argv.slice(2);
const definition = (await import(pathToFileURL(file).href)).default;
if (definition.runtime !== 'node' || typeof definition.run !== 'function') throw new Error('Invalid Node benchmark');
const startedAt = performance.now();
const measurements = await definition.run(JSON.parse(encodedOptions));
await fs.writeFile(output, JSON.stringify({ measurements, elapsedMs: performance.now() - startedAt }, null, 2) + '\n');
