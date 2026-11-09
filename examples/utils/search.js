/** Pure metadata matching, shared independently of either application's UI. */
export function filterExamples(examples, query = '') {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return examples.filter(example => {
    const author = typeof example.author === 'string' ? example.author : example.author?.name;
    const text = [example.title, example.description, example.category, ...(example.tags ?? []), author]
      .filter(Boolean).join(' ').toLocaleLowerCase();
    return words.every(word => text.includes(word));
  });
}
