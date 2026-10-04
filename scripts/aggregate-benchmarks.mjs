import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  resolve,
} from 'node:path';

const [
  outputPath,
  ...inputPaths
] = process.argv.slice(2);

if (!outputPath || inputPaths.length === 0) {
  throw new Error(
    'Usage: aggregate-benchmarks.mjs <output.json> <input-a.json> [input-b.json ...]',
  );
}

function median(values) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (sorted.length === 0) return undefined;

  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function aggregateResult(results) {
  const first = results[0];
  const aggregate = { ...first };

  for (const key of Object.keys(first)) {
    if (typeof first[key] !== 'number') continue;

    const value = median(
      results.map((result) => result[key]),
    );

    if (value !== undefined) aggregate[key] = value;
  }

  aggregate.samples = results;

  return aggregate;
}

const payloads = inputPaths.map((inputPath) => JSON.parse(
  readFileSync(resolve(inputPath), 'utf8'),
));

const resultNames = payloads[0].results.map((result) => result.name);

for (const payload of payloads) {
  const names = payload.results.map((result) => result.name);

  if (
    names.length !== resultNames.length
    || names.some((name, index) => name !== resultNames[index])
  ) {
    throw new Error(
      'Cannot aggregate benchmark payloads with different case ordering.',
    );
  }
}

const resultMaps = payloads.map((payload) => new Map(
  payload.results.map((result) => [result.name, result]),
));

const aggregate = {
  metadata: {
    ...payloads[0].metadata,
    measuredAt: new Date().toISOString(),
    sampleCount: payloads.length,
    samples: payloads.map((payload, index) => ({
      index,
      metadata: payload.metadata,
    })),
  },
  results: resultNames.map((name) => aggregateResult(
    resultMaps.map((resultMap) => resultMap.get(name)),
  )),
};

const resolvedOutputPath = resolve(outputPath);

mkdirSync(dirname(resolvedOutputPath), {
  recursive: true,
});

writeFileSync(
  resolvedOutputPath,
  `${JSON.stringify(aggregate, null, 2)}\n`,
);

console.log(
  `Aggregated ${payloads.length} benchmark sample(s) into ${resolvedOutputPath}`,
);
