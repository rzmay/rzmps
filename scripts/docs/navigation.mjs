import fs from 'node:fs';
import path from 'node:path';

// Reading order lives here; displayed titles always come from the article itself.
export const guideSections = [
  { text: 'Getting Started', description: 'Build an effect, then extend it with your own behavior.', pages: ['first-particle-system', 'first-module', 'first-spatial-effect'] },
  { text: 'GPU Processing', description: 'Port custom behavior to GPU compute and understand the GPU execution model.', pages: ['first-gpu-module', 'first-gpu-spatial-effect', 'gpu-processing'] },
  { text: 'Core Concepts', description: 'Understand how systems and their components work together.', pages: ['concepts', 'dynamic-values', 'module-priority', 'spatial-effects'] },
  { text: 'Feature Guides', description: 'Apply individual features to an existing particle system.', pages: ['renderer-children-lod', 'tags', 'subsystems', 'collision-and-physics', 'decals', 'particle-octree'] },
  { text: 'Project Guides', description: 'Set up local development, measure performance, validate effects, and use coding assistants.', pages: ['development', 'benchmarks', 'compatibility', 'ai-coding-assistants'] },
];

export function guideNavigation(directory, generated = new Map()) {
  const included = new Set();
  const sections = guideSections.map(section => ({
    ...section,
    items: section.pages.map(slug => {
      if (included.has(slug)) throw new Error(`Guide appears more than once in navigation: ${slug}`);
      included.add(slug);
      const source = generated.get(slug) ?? fs.readFileSync(path.join(directory, slug + '.md'), 'utf8');
      const text = source.match(/^# (.+)$/m)?.[1];
      if (!text) throw new Error(`${slug}: missing article title`);
      return { text, link: `/guides/${slug}` };
    }),
  }));
  for (const file of fs.readdirSync(directory).filter(file => file.endsWith('.md') && file !== 'index.md')) {
    if (!included.has(file.slice(0, -3))) throw new Error(`Guide missing from navigation: ${file}`);
  }
  return sections;
}

export function guideIndex(sections) {
  return '# Guides\n\nStart with the tutorials, learn the core concepts, then choose the feature you need.\n\n' + sections.map(section =>
    `## ${section.text}\n\n${section.description}\n\n` + section.items.map(item => `- [${item.text}](./${path.basename(item.link)}.md)`).join('\n'),
  ).join('\n\n') + '\n';
}
