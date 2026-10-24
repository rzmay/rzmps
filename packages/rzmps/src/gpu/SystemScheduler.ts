import type ParticleSystem from '../ParticleSystem';
import type { SubSystemOptions } from '../ParticleSystem';

export interface GPUSystemScheduleNode {
  system: ParticleSystem;
  parent?: ParticleSystem;
  options?: SubSystemOptions;
  depth: number;
  index: number;
}

export interface GPUSystemSchedule {
  root: ParticleSystem;
  nodes: GPUSystemScheduleNode[];
}

/**
 * Produces a stable parent-before-child traversal for one GPU simulation frame.
 * Shared subsystem instances are visited once, while `visiting` detects cycles
 * before the schedule is handed to ParticleSystem's allocation/emission passes.
 */
export function buildGPUSystemSchedule(root: ParticleSystem): GPUSystemSchedule {
  const nodes: GPUSystemScheduleNode[] = [];
  const visiting = new Set<ParticleSystem>();
  const visited = new Set<ParticleSystem>();

  const visit = (
    system: ParticleSystem,
    parent: ParticleSystem | undefined,
    options: SubSystemOptions | undefined,
    depth: number,
  ) => {
    if (visiting.has(system)) {
      throw new Error('ParticleSystem GPU subsystem graph contains a dependency cycle.');
    }

    if (visited.has(system)) return;

    visiting.add(system);
    nodes.push({
      system,
      parent,
      options,
      depth,
      index: nodes.length,
    });

    system.subSystems.forEach((childOptions, child) => {
      visit(child, system, childOptions, depth + 1);
    });

    visiting.delete(system);
    visited.add(system);
  };

  visit(root, undefined, undefined, 0);

  return {
    root,
    nodes,
  };
}
