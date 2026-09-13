import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const root = path.resolve(__dirname, '..');
const sourceDir = path.join(root, 'src/shaders');
const outputDir = path.join(root, 'build/shaders');

await fs.mkdir(outputDir, { recursive: true });

const files = await fs.readdir(sourceDir);

await Promise.all(
  files
    .filter((file) => file.endsWith('.vert') || file.endsWith('.frag'))
    .map(async (file) => {
      const sourcePath = path.join(sourceDir, file);
      const outputPath = path.join(outputDir, `${file}.js`);

      const source = await fs.readFile(sourcePath, 'utf8');

      await fs.writeFile(
        outputPath,
        `export default ${JSON.stringify(source)};\n`,
        'utf8',
      );
    }),
);
