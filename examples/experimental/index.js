import createFlipFluid, { metadata as flipMetadata } from './flipFluid.js';

export const experimentalExamples = [
  { ...flipMetadata, create: createFlipFluid },
].map((example) => {
  const sourceUrl = `https://github.com/rzmay/rzmps/blob/develop/examples/experimental/${example.id}.js`;
  example.create.sourceUrl = sourceUrl;
  example.author = example.create.metadata.author;
  example.previewSettings = { backend: 'webgpu' };
  example.create.metadata.previewSettings = example.previewSettings;
  return { ...example, sourceUrl };
});

export default Object.fromEntries(experimentalExamples.map(entry => [entry.title, entry]));
