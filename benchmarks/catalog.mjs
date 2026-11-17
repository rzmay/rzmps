import fs from 'node:fs';
import ts from 'typescript';
import { discoverFiles } from '../scripts/discover.utils.mjs';

/** Read only literal metadata while discovering; listing a benchmark must never execute its workloads. */
export function discoverBenchmarks(root) {
  const ids = new Set();
  return discoverFiles(root, 'benchmarks', /\.benchmark\.(js|mjs)$/).map(file => {
    const ast = ts.createSourceFile(
      file.absolute,
      fs.readFileSync(file.absolute, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const descriptor = ast.statements.find(ts.isExportAssignment)?.expression;
    if (!descriptor || !ts.isObjectLiteralExpression(descriptor))
      throw new Error(`${file.path}: export a benchmark descriptor`);
    const metadata = {};
    for (const property of descriptor.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      if (ts.isStringLiteral(property.initializer)) metadata[property.name.getText(ast)] = property.initializer.text;
      if (ts.isArrayLiteralExpression(property.initializer) && property.initializer.elements.every(ts.isStringLiteral))
        metadata[property.name.getText(ast)] = property.initializer.elements.map(value => value.text);
    }
    if (!metadata.id || !metadata.name || !metadata.feature || !['node', 'browser'].includes(metadata.runtime))
      throw new Error(`${file.path}: id, name, feature and runtime are required literal metadata`);
    if (!metadata.backends?.length || metadata.backends.some(backend => !['cpu', 'gpu'].includes(backend)))
      throw new Error(`${file.path}: backends must contain cpu and/or gpu`);
    if (ids.has(metadata.id)) throw new Error(`Duplicate benchmark ID: ${metadata.id}`);
    ids.add(metadata.id);
    return { ...file, ...metadata };
  });
}
