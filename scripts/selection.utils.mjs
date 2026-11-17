/** JSON selectors use regexes, with * as the match-all shortcut. Fields within a rule are ANDed; rules are ORed. */
export function matchesRule(entry, rule) {
  return Object.entries(rule).every(([field, pattern]) => {
    if (pattern === '*') return true;
    const expression = new RegExp(pattern, 'i');
    const value = field === 'backend' ? (entry.backend ?? entry.benchmarkMode ?? entry.backends) : entry[field];
    return Array.isArray(value)
      ? value.some(item => expression.test(String(item)))
      : expression.test(String(value ?? ''));
  });
}

export function selectEntries(entries, configuration, set = 'full', stack = []) {
  let candidates = entries;
  const definition = configuration.sets[set];
  if (!definition) throw new Error(`Unknown selection set: ${set}`);
  if (stack.includes(set)) throw new Error(`Cyclic selection set: ${[...stack, set].join(' -> ')}`);
  if (definition.extends) {
    const parents = definition.extends.flatMap(parent =>
      selectEntries(entries, configuration, parent, [...stack, set]),
    );
    candidates = entries.filter(entry => parents.includes(entry));
  }
  const include = definition.include ?? [{}];
  const exclude = definition.exclude ?? [];
  return candidates.filter(
    entry => include.some(rule => matchesRule(entry, rule)) && !exclude.some(rule => matchesRule(entry, rule)),
  );
}
