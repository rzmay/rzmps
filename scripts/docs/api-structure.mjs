import path from 'node:path';
import ts from 'typescript';

const compare = (a, b) => a.text.localeCompare(b.text, 'en');
const priority = ['ParticleSystem', 'Particle', 'Emitter', 'EmissionShape', 'Module', 'Renderer', 'SpriteRenderer',
  'MeshRenderer', 'TrailRenderer', 'LightRenderer', 'AudioRenderer', 'SpatialEffect', 'ParticleForceField',
  'BoidAffector', 'KillZone', 'ParticleOctree', 'ParticleSpatialGrid', 'GPUParticleContext',
  'GPUParticleBufferState', 'GPUSelectiveReadbackState', 'LODHelper', 'LiveCubemap', 'Textures',
  'ParticleSystemOptions', 'ParticleOptions', 'EmitterOptions', 'EmissionShapeOptions', 'ModuleOptions',
  'RendererOptions', 'DynamicValue', 'DynamicUntimedValue', 'ValueByParameter'];
const importantFirst = (a, b) => {
  const rank = item => { const index = priority.indexOf(item.text); return index < 0 ? priority.length : index; };
  return rank(a) - rank(b) || compare(a, b);
};

function exportSources(source) {
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  return new Map(ast.statements.filter(ts.isExportDeclaration).flatMap(statement =>
    statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)
      ? statement.exportClause.elements.map(element => [element.name.text, statement.moduleSpecifier.text]) : [],
  ));
}

function classSection(name, source) {
  if (/^GPU/.test(name) || name === 'ParticleSpatialGrid') return 'GPU Infrastructure';
  if (['./ParticleSystem', './Particle', './EmissionSource'].includes(source)) return 'Particle Systems';
  if (['./Emitter', './EmissionShape'].includes(source)) return 'Emitters';
  if (source === './Module' || source?.startsWith('./modules/')) return 'Modules';
  if (source === './Renderer' || (source?.startsWith('./renderers/') && name !== 'LiveCubemap')) return 'Renderers';
  if (source?.startsWith('./gpu/')) return 'GPU Infrastructure';
  if (name.endsWith('Helper') || name === 'LiveCubemap' || source?.startsWith('./helpers/') ||
    source?.startsWith('./collision/')) return 'Helpers';
  if (source === './SpatialEffect' || source?.startsWith('./spatial/')) return 'Spatial Effects';
  throw new Error(`API class needs a navigation section: ${name} (${source})`);
}

/** Group actual TypeDoc pages using the public export source, retaining TypeDoc's URLs. */
export function apiNavigation(pages, entrySource) {
  const sources = exportSources(entrySource);
  const sections = [
    { text: 'Particle Systems',
      description: 'Start with ParticleSystem, which owns simulation, and Particle, which ' +
        'holds each particle’s state.' },
    { text: 'Emitters',
      description: 'Choose where particles are born and configure their initial values, timing, and selection.' },
    { text: 'Modules',
      description: 'Start with the Module base class, then choose modifiers for motion, appearance, or behavior.' },
    { text: 'Renderers',
      description: 'Start with Renderer, then represent particles as sprites, meshes, trails, lights, or audio.' },
    { text: 'Spatial Effects', description: 'Apply shared scene influences, force fields, and spatial selection.' },
    { text: 'GPU Infrastructure',
      description: 'Build advanced GPU extensions with particle-node views, buffers, selective ' +
        'readback, scheduling, events, and spatial queries.' },
    { text: 'Types',
      description: 'Look up constructor options, dynamic values, enums, callbacks, and data ' +
        'contracts used by the public API. Supporting types appear here even when they are not ' +
        'direct package exports.' },
    { text: 'Helpers',
      description: 'Find spatial indexing, level of detail, collision backends, cubemap ' +
        'utilities, textures, and debug visualization.' },
  ].map(section => ({ ...section, items: [] }));
  const byName = new Map(sections.map(section => [section.text, section]));
  const types = new Map(['Options and Configuration', 'Dynamic Values', 'Enums', 'Callbacks',
    'Data and Contracts'].map(text => [text, []]));
  const modules = new Map(['Motion', 'Appearance', 'Behavior'].map(text => [text, []]));
  for (const [file, content] of pages) {
    const match = file.match(/(?:^|\/)(classes|interfaces|enumerations|type-aliases)\/[^/]+\.md$/);
    if (!match) {
      if (file.endsWith('/namespaces/Textures/index.md')) {
        byName.get('Helpers').items.push({ text: 'Textures', link: '/api/' + file.replace(/\.md$/, '') });
      }
      continue;
    }
    const heading = content.match(/^# (?:Abstract )?(?:Class|Interface|Enumeration|Type Alias): ([\w$]+)/m);
    if (!heading) throw new Error(`Cannot read API title: ${file}`);
    const name = heading[1];
    const item = { text: name, link: '/api/' + file.replace(/\.md$/, '') };
    if (match[1] === 'classes') {
      const section = classSection(name, sources.get(name));
      if (section === 'Modules' && name !== 'Module') {
        const category = /^(Color|Distortion|Scale|Rotation)/.test(name) ? 'Appearance'
          : /^(Force|LimitVelocity|Velocity|Speed|Transform|Orient|Noise|Mass)/.test(name) ? 'Motion' : 'Behavior';
        modules.get(category).push(item);
      } else byName.get(section).items.push(item);
    } else {
      const category = match[1] === 'enumerations' ? 'Enums'
        : /(Options|Settings|Config)$/.test(name) ? 'Options and Configuration'
        : /^(Dynamic|ValueByParameter)/.test(name) ? 'Dynamic Values'
        : /(Update|Listener|Modifier|Test)$/.test(name) ? 'Callbacks' : 'Data and Contracts';
      types.get(category).push(item);
    }
  }
  for (const section of sections) section.items.sort(importantFirst);
  for (const [text, items] of modules) if (items.length) byName.get('Modules').items.push({ text,
    items: items.sort(compare) });
  for (const [text, items] of types) if (items.length) byName.get('Types').items.push({ text,
    items: items.sort(importantFirst) });
  return sections;
}

export function apiIndex(sections) {
  const links = items => items.map(item => `- [${item.text}](${path.posix.relative('/api', item.link)}.md)`).join('\n');
  return '# API Reference\n\nBrowse by responsibility. The main classes come first; ' +
    'configuration and supporting types are grouped below.\n\n' + sections.map(section =>
    `## ${section.text}\n\n${section.description}\n\n` + [
      links(section.items.filter(item => item.link)),
      ...section.items.filter(item => item.items).map(group => `### ${group.text}\n\n${links(group.items)}`),
    ].filter(Boolean).join('\n\n'),
  ).join('\n\n') + '\n';
}
