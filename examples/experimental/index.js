import createFlipFluid, { metadata as flipMetadata } from './flipFluid.js';
import createGasVolume, { metadata as gasMetadata } from './gasVolume.js';
import createGasNiagaraBurst, { metadata as niagaraMetadata } from './gasNiagaraBurst.js';
import createGasBlenderSmoke, { metadata as blenderMetadata } from './gasBlenderSmoke.js';

export const experimentalExamples = [
  { ...flipMetadata, create: createFlipFluid },
  { ...gasMetadata, create: createGasVolume },
  { ...niagaraMetadata, create: createGasNiagaraBurst },
  { ...blenderMetadata, create: createGasBlenderSmoke },
].map((example) => {
  const sourceUrl = `https://github.com/rzmay/rzmps/blob/develop/examples/experimental/${example.id}.js`;
  example.create.sourceUrl = sourceUrl;
  example.author = example.create.metadata.author;
  example.previewSettings = { backend: 'webgpu' };
  example.create.metadata.previewSettings = example.previewSettings;
  return { ...example, sourceUrl };
});

export default Object.fromEntries(experimentalExamples.map(entry => [entry.title, entry]));
