import * as THREE from 'three';
import { LineBasicNodeMaterial } from 'three/webgpu';
import { color, instanceIndex, positionLocal, uniform } from 'three/tsl';
import type SparseVolumeGrid from '../../spatial/structures/gpu/SparseVolumeGrid';

/** Instanced wireframes read the live GPU directory, without per-frame CPU readback. */
export default class FluidGridHelper extends THREE.LineSegments {
  readonly grid: SparseVolumeGrid;
  private readonly minimum = uniform(new THREE.Vector3());

  constructor(grid: SparseVolumeGrid) {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const edges = new THREE.EdgesGeometry(box);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', edges.getAttribute('position').clone());
    geometry.instanceCount = grid.brickCount;
    box.dispose();
    edges.dispose();

    const material = new LineBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false });
    super(geometry, material);
    this.grid = grid;
    const brick = grid.visualization(instanceIndex);
    material.positionNode = positionLocal.add(0.5).add(brick.xyz).mul(grid.brickSize).add(this.minimum);
    material.colorNode = brick.w.greaterThan(0).select(color(0xffa342), color(0x45c99b));
    material.opacity = 0.55;
    this.name = 'Fluid Domain Bricks (orange: occupied, green: empty)';
    this.frustumCulled = false;
    this.renderOrder = 1000;
    this.updateBounds();
  }

  updateBounds(): void {
    this.minimum.value.copy(this.grid.bounds.min);
    (this.geometry as THREE.InstancedBufferGeometry).instanceCount = this.grid.brickCount;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.material as THREE.Material).dispose();
  }
}
