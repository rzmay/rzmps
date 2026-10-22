import { Converter, normalizePath } from 'typedoc';

/** Keep only signature-reachable types added by the missing-exports plugin.
 * That plugin also observes references from private members before TypeDoc hides them.
 */
export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_END, context => {
    const project = context.project;
    const module = project.children?.find(child => child.name === app.options.getValue('internalModule'));
    if (!module) return;
    const serialized = app.serializer.projectToObject(project, normalizePath(process.cwd()));
    const serializedModule = serialized.children.find(child => child.id === module.id);
    const owners = new Map();
    const entries = new Map(serializedModule.children.map(child => [child.id, child]));
    function walk(value, visit) {
      if (!value || typeof value !== 'object') return;
      visit(value);
      for (const child of Object.values(value)) {
        if (Array.isArray(child)) child.forEach(item => walk(item, visit));
        else if (child && typeof child === 'object') walk(child, visit);
      }
    }
    for (const [id, entry] of entries) walk(entry, value => {
      if (typeof value.id === 'number') owners.set(value.id, id);
    });
    const retained = new Set();
    function references(value) {
      walk(value, type => {
        if (type.type !== 'reference' || typeof type.target !== 'number') return;
        const owner = owners.get(type.target);
        if (owner === undefined || retained.has(owner)) return;
        retained.add(owner);
        references(entries.get(owner));
      });
    }
    references(serialized.children.filter(child => child.id !== module.id));
    for (const child of [...module.children]) if (!retained.has(child.id)) project.removeReflection(child);
  });
}
