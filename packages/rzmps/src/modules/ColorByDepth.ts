import * as THREE from 'three';
import Module, { ModuleOptions } from '../Module';
import Particle from '../Particle';
import type ParticleSystem from '../ParticleSystem';
import type { ValueByParameter } from '../types/ValueByParameter';
import type { Node } from 'three/webgpu';
import { vec3 } from 'three/tsl';
import evaluateByParameterColor from '../helpers/evaluateByParameterColor';
import evaluateByParameterNumber from '../helpers/evaluateByParameterNumber';
import {
  evaluateByParameterColorGPU,
  evaluateByParameterNumberGPU,} from '../helpers/evaluateByParameterGPU';

export interface ColorByDepthOptions extends Partial<ModuleOptions> {
  color: ValueByParameter<THREE.Color>;
  alpha: ValueByParameter<number>;

  depthRange?: [number, number];
}

class ColorByDepth extends Module {
  cameraPosition: THREE.Vector3 = new THREE.Vector3();
  depthRange?: [number, number];

  private _cameraDepthRange: [number, number] = [0, 100];

  constructor(public options: Partial<ColorByDepthOptions> = {}) {

    super((particle: Particle) => {
      const t = THREE.MathUtils.clamp(
        THREE.MathUtils.mapLinear(
          particle.position.distanceTo(this.cameraPosition),
          this.depthRange?.[0] ?? this._cameraDepthRange[0],
          this.depthRange?.[1] ?? this._cameraDepthRange[1],
          0,
          1,
        ),
        0,
        1,
      );

      if (this.options.color !== undefined) {
        particle.color.multiply(evaluateByParameterColor(this.options.color, t));
      }
      if (this.options.alpha !== undefined) {
        particle.alpha *= evaluateByParameterNumber(this.options.alpha, t);
      }
    }, {
      ...options,
      priority: 1,
      modifyGPU: (particle) => {
          const t = this.getDepthTimeGPU(particle.position);

          if (this.options.color !== undefined) {
            particle.color.assign(
              particle.color.mul(evaluateByParameterColorGPU(this.options.color, t)),
            );
          }
          if (this.options.alpha !== undefined) {
            particle.alpha.assign(
              particle.alpha.mul(evaluateByParameterNumberGPU(this.options.alpha, t, 1)),
            );
          }
        }
    });

    this.depthRange = options.depthRange;
  }

  public prepare(particleSystem: ParticleSystem): void {
    const camera = particleSystem.sceneCamera;

    if (camera) {
      camera.getWorldPosition(this.cameraPosition);

      if (particleSystem.simulationSpace !== 'world') {
        particleSystem.worldToLocal(this.cameraPosition);
      }

      if (camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera) {
        this._cameraDepthRange = [camera.near, camera.far];
      }
    }
  }

  private getDepthTimeGPU(position: Node<'vec3'>) {
    const min = this.depthRange?.[0] ?? this._cameraDepthRange[0];
    const max = this.depthRange?.[1] ?? this._cameraDepthRange[1];

    return position.sub(vec3(this.cameraPosition)).length().sub(min).div(max - min || 1).clamp(0, 1);
  }
}

export default ColorByDepth;
