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
const sharedNames = base.results
  .map((result) => result.name)
  .filter((name) => headByName.has(name));

if (sharedNames.length === 0) {
  throw new Error('Base and PR benchmarks have no cases in common');
}

const sharedNameSet = new Set(sharedNames);
const baseOnly = base.results
  .map((result) => result.name)
  .filter((name) => !sharedNameSet.has(name));
const headOnly = head.results
  .map((result) => result.name)
  .filter((name) => !sharedNameSet.has(name));

base.results = base.results.filter((result) => sharedNameSet.has(result.name));
head.results = sharedNames.map((name) => headByName.get(name));

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
