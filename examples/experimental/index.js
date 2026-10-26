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
  return { ...example, sourceUrl };
});

export default Object.fromEntries(experimentalExamples.map(({ title, create }) => [title, create]));
