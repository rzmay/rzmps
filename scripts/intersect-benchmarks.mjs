import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateBenchmark } from './benchmark-payload.mjs';

const [baseInput, headInput] = process.argv.slice(2);

if (!baseInput || !headInput) {
  throw new Error('Usage: intersect-benchmarks.mjs <base.json> <head.json>');
}

const basePath = resolve(baseInput);
const headPath = resolve(headInput);
const base = JSON.parse(readFileSync(basePath, 'utf8'));
const head = JSON.parse(readFileSync(headPath, 'utf8'));
validateBenchmark(base);
validateBenchmark(head);

const headByName = new Map(head.results.map((result) => [result.name, result]));
const matches = base.results.flatMap((baseResult) => {
  const exact = headByName.get(baseResult.name);
  if (exact) return [{ base: baseResult, head: exact, name: baseResult.name }];

  // Benchmark cases were originally CPU-only and had no mode suffix. Preserve
  // comparisons with those revisions by matching them to the newer CPU case.
  const cpuName = `${baseResult.name} [CPU]`;
  const cpu = headByName.get(cpuName);
  return cpu ? [{ base: baseResult, head: cpu, name: cpuName }] : [];
});
const sharedNames = matches.map((match) => match.name);

if (sharedNames.length === 0) {
  throw new Error('Base and PR benchmarks have no cases in common');
}

const matchedBaseNames = new Set(matches.map((match) => match.base.name));
const matchedHeadNames = new Set(matches.map((match) => match.head.name));
const baseOnly = base.results
  .map((result) => result.name)
  .filter((name) => !matchedBaseNames.has(name));
const headOnly = head.results
  .map((result) => result.name)
  .filter((name) => !matchedHeadNames.has(name));

base.results = matches.map(({ base: result, name }) => ({ ...result, name }));
head.results = matches.map(({ head: result, name }) => ({ ...result, name }));

for (const payload of [base, head]) {
  payload.metadata.caseIntersection = {
    compared: sharedNames,
    baseOnly,
    headOnly,
  };
}

writeFileSync(basePath, `${JSON.stringify(base, null, 2)}\n`);
writeFileSync(headPath, `${JSON.stringify(head, null, 2)}\n`);
console.log(`Retained ${sharedNames.length} shared benchmark case(s)`);
