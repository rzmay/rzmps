/** Build a deterministic catalog from eager default imports without modifying factories. */
export function createRegistry(modules, directory) {
  const ids = new Set(), titles = new Set();
  return Object.entries(modules).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([file, factory]) => {
    const metadata = factory?.metadata;
    if (typeof factory !== 'function' || !metadata?.id || !metadata.title || !metadata.author) {
      throw new Error(`${file}: factory.metadata must provide id, title and author`);
    }
    if (ids.has(metadata.id) || titles.has(metadata.title)) throw new Error(`${file}: duplicate catalog id or title`);
    ids.add(metadata.id); titles.add(metadata.title);
    const filename = file.split('/').at(-1);
    return { create: factory, ...metadata,
      sourceUrl: `https://github.com/rzmay/rzmps/blob/develop/examples/${directory}/${filename}` };
  });
}
