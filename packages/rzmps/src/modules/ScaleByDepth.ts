import * as THREE from 'three';
import Module, { ModuleOptions } from '../Module';
import Particle from '../Particle';
import type ParticleSystem from '../ParticleSystem';
import type { ValueByParameter } from '../types/ValueByParameter';
import type { Node } from 'three/webgpu';
import { vec3 } from 'three/tsl';
import evaluateByParameterVector from '../helpers/evaluateByParameterVector3';
import {
  evaluateByParameterVectorGPU,} from '../helpers/evaluateByParameterGPU';

export interface ScaleByDepthOptions extends Partial<ModuleOptions> {
  scale: ValueByParameter<THREE.Vector3>;
  scalarVelocity: ValueByParameter<THREE.Vector3>;
  scalarAcceleration: ValueByParameter<THREE.Vector3>;
  depthRange?: [number, number]
}

class ScaleByDepth extends Module {
  cameraPosition: THREE.Vector3 = new THREE.Vector3();
  depthRange?: [number, number];

  private _cameraDepthRange: [number, number] = [0, 100];

  constructor(public options: ScaleByDepthOptions) {

    super((particle: Particle) => {
      const time = THREE.MathUtils.clamp(
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

      particle.scale.multiply(
        evaluateByParameterVector(
          this.options.scale ?? new THREE.Vector3(1, 1, 1),
          time,
        ),
      );
      particle.scalarVelocity.add(
        evaluateByParameterVector(
          this.options.scalarVelocity ?? new THREE.Vector3(),
          time,
        ),
      );
      particle.scalarAcceleration.add(
        evaluateByParameterVector(
          this.options.scalarAcceleration ?? new THREE.Vector3(),
          time,
        ),
      );
    }, {
      priority: 1,
      ...options,
      modifyGPU: (particle) => {
          const time = this.getDepthTimeGPU(particle.position);

          particle.scale.assign(
            particle.scale.mul(evaluateByParameterVectorGPU(
              this.options.scale ?? new THREE.Vector3(1, 1, 1),
              time,
              new THREE.Vector3(1, 1, 1),
            )),
          );
          particle.scalarVelocity.assign(
            particle.scalarVelocity.add(evaluateByParameterVectorGPU(
              this.options.scalarVelocity ?? new THREE.Vector3(),
              time,
            )),
          );
          particle.scalarAcceleration.assign(
            particle.scalarAcceleration.add(evaluateByParameterVectorGPU(
              this.options.scalarAcceleration ?? new THREE.Vector3(),
              time,
            )),
          );
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

export default ScaleByDepth;
