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
  baseInput,
  headInput,
  markdownOutput = 'benchmark-comparison.md',
  jsonOutput = 'benchmark-comparison.json',
] = process.argv.slice(2);

if (!baseInput || !headInput) {
  throw new Error(
    'Usage: compare-benchmarks.mjs <base.json> <head.json> [comparison.md] [comparison.json]',
  );
}

const basePath = resolve(baseInput);
const headPath = resolve(headInput);

const base = JSON.parse(
  readFileSync(basePath, 'utf8'),
);

const head = JSON.parse(
  readFileSync(headPath, 'utf8'),
);

const metrics = [
  {
    key: 'avgUpdateMs',
    label: 'Avg Update',
    unit: 'ms',
    lowerIsBetter: true,
    digits: 2,
  },
  {
    key: 'p95UpdateMs',
    label: 'P95 Update',
    unit: 'ms',
    lowerIsBetter: true,
    digits: 2,
  },
  {
    key: 'avgFrameMs',
    label: 'Avg Frame',
    unit: 'ms',
    lowerIsBetter: true,
    digits: 2,
  },
  {
    key: 'p99FrameMs',
    label: 'P99 Frame',
    unit: 'ms',
    lowerIsBetter: true,
    digits: 2,
  },
  {
    key: 'avgFps',
    label: 'Avg FPS',
    unit: '',
    lowerIsBetter: false,
    digits: 1,
  },
  {
    key: 'onePercentLowFps',
    label: '1% Low FPS',
    unit: '',
    lowerIsBetter: false,
    digits: 1,
  },
];

function isValidNumber(value) {
  return (
    typeof value === 'number'
    && Number.isFinite(value)
    && value > 0
  );
}

function percentChange(baseValue, headValue) {
  if (
    !isValidNumber(baseValue)
    || !isValidNumber(headValue)
  ) {
    return null;
  }

  return (
    (headValue / baseValue) - 1
  ) * 100;
}

function formatValue(value, metric) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }

  return `${value.toFixed(metric.digits)}${metric.unit}`;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }

  const sign = value > 0
    ? '+'
    : '';

  return `${sign}${value.toFixed(2)}%`;
}

function geometricMeanRatio(ratios) {
  const valid = ratios.filter(
    (ratio) => (
      Number.isFinite(ratio)
      && ratio > 0
    ),
  );

  if (valid.length === 0) {
    return null;
  }

  return Math.exp(
    valid.reduce(
      (sum, ratio) => sum + Math.log(ratio),
      0,
    ) / valid.length,
  );
}

const baseByName = new Map(
  base.results.map(
    (result) => [result.name, result],
  ),
);

const headByName = new Map(
  head.results.map(
    (result) => [result.name, result],
  ),
);

const allNames = [
  ...new Set([
    ...baseByName.keys(),
    ...headByName.keys(),
  ]),
];

const comparisons = [];
const missing = [];

for (const name of allNames) {
  const baseResult = baseByName.get(name);
  const headResult = headByName.get(name);

  if (!baseResult || !headResult) {
    missing.push({
      name,
      base: Boolean(baseResult),
      head: Boolean(headResult),
    });

    continue;
  }

  const metricResults = {};

  for (const metric of metrics) {
    const baseValue = baseResult[metric.key];
    const headValue = headResult[metric.key];

    metricResults[metric.key] = {
      base: baseValue,
      head: headValue,
      percentChange: percentChange(
        baseValue,
        headValue,
      ),
    };
  }

  comparisons.push({
    name,
    metrics: metricResults,
  });
}

const overall = {};

for (const metric of metrics) {
  const ratios = comparisons
    .map((comparison) => {
      const value =
        comparison.metrics[metric.key];

      if (
        !isValidNumber(value.base)
        || !isValidNumber(value.head)
      ) {
        return null;
      }

      return value.head / value.base;
    })
    .filter(Boolean);

  const ratio =
    geometricMeanRatio(ratios);

  overall[metric.key] = ratio === null
    ? null
    : {
      ratio,
      percentChange:
        (ratio - 1) * 100,
    };
}

const output = {
  generatedAt:
    new Date().toISOString(),

  base: {
    metadata: base.metadata,
  },

  head: {
    metadata: head.metadata,
  },

  comparisons,
  overall,
  missing,
};

const tableRows = comparisons.map(
  (comparison) => {
    const cells = [
      comparison.name,
    ];

    for (const metric of metrics) {
      const result =
        comparison.metrics[metric.key];

      cells.push(
        `${formatValue(result.base, metric)} → ${formatValue(result.head, metric)
        } (${formatPercent(result.percentChange)})`,
      );
    }

    return `| ${cells.join(' | ')} |`;
  },
);

const overallRows = metrics.map(
  (metric) => {
    const result =
      overall[metric.key];

    return [
      metric.label,
      result
        ? formatPercent(result.percentChange)
        : 'n/a',
      metric.lowerIsBetter
        ? 'Lower is better'
        : 'Higher is better',
    ];
  },
);

function markdownTable(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(
      (row) => `| ${row.join(' | ')} |`,
    ),
  ].join('\n');
}

const environmentWarnings = [];

const baseHardware =
  base.metadata?.hardware ?? {};

const headHardware =
  head.metadata?.hardware ?? {};

if (
  baseHardware.cpu
  && headHardware.cpu
  && baseHardware.cpu !== headHardware.cpu
) {
  environmentWarnings.push(
    `CPU differs: base \`${baseHardware.cpu}\`, head \`${headHardware.cpu}\`.`,
  );
}

if (
  baseHardware.webglRenderer
  && headHardware.webglRenderer
  && baseHardware.webglRenderer
  !== headHardware.webglRenderer
) {
  environmentWarnings.push(
    `WebGL renderer differs: base \`${baseHardware.webglRenderer}\`, head \`${headHardware.webglRenderer}\`.`,
  );
}

if (
  base.metadata?.browser
  && head.metadata?.browser
  && base.metadata.browser
  !== head.metadata.browser
) {
  environmentWarnings.push(
    `Browser differs: base \`${base.metadata.browser}\`, head \`${head.metadata.browser}\`.`,
  );
}

const markdown = [
  '<!-- rzmps-benchmark-report -->',
  '',
  '## 📊 Benchmark comparison',
  '',
  'Base and PR benchmarks were run sequentially on the same GitHub Actions runner.',
  '',
  '**Interpretation:** negative percentages are improvements for time metrics; positive percentages are improvements for FPS metrics.',
  '',
  `| Case | ${metrics.map(
    (metric) => metric.label,
  ).join(' | ')
  } |`,
  `| --- | ${metrics.map(() => '---:').join(' | ')
  } |`,
  ...tableRows,
  '',
  '### Overall',
  '',
  markdownTable(
    [
      'Metric',
      'Geometric mean change',
      'Direction',
    ],
    overallRows,
  ),
  '',
];

if (missing.length > 0) {
  markdown.push(
    '### Benchmark-set changes',
    '',
  );

  for (const item of missing) {
    markdown.push(
      `- \`${item.name}\`: ${item.base
        ? 'missing from PR'
        : 'new in PR'
      }`,
    );
  }

  markdown.push('');
}

if (environmentWarnings.length > 0) {
  markdown.push(
    '### ⚠️ Environment differences',
    '',
    ...environmentWarnings.map(
      (warning) => `- ${warning}`,
    ),
    '',
  );
}

markdown.push(
  '<sub>CI performance measurements are comparative rather than absolute. Small differences may be runner/browser noise.</sub>',
  '',
);

const markdownPath =
  resolve(markdownOutput);

const jsonPath =
  resolve(jsonOutput);

mkdirSync(
  dirname(markdownPath),
  {
    recursive: true,
  },
);

mkdirSync(
  dirname(jsonPath),
  {
    recursive: true,
  },
);

writeFileSync(
  markdownPath,
  `${markdown.join('\n')}\n`,
);

writeFileSync(
  jsonPath,
  `${JSON.stringify(output, null, 2)}\n`,
);

console.log(
  `Wrote ${markdownPath}`,
);

console.log(
  `Wrote ${jsonPath}`,
);
