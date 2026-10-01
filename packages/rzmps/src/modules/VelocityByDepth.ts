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

export interface VelocityByDepthOptions extends Partial<ModuleOptions> {
  position: ValueByParameter<THREE.Vector3>;
  velocity: ValueByParameter<THREE.Vector3>;
  acceleration: ValueByParameter<THREE.Vector3>;
  depthRange?: [number, number];
}

class VelocityByDepth extends Module {
  cameraPosition: THREE.Vector3 = new THREE.Vector3();
  depthRange?: [number, number];

  private _cameraDepthRange: [number, number] = [0, 100];

  constructor(public options: Partial<VelocityByDepthOptions> = {}) {

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

      particle.position.add(
        evaluateByParameterVector(
          this.options.position ?? new THREE.Vector3(),
          time,
        ),
      );
      particle.velocity.add(
        evaluateByParameterVector(
          this.options.velocity ?? new THREE.Vector3(),
          time,
        ),
      );
      particle.acceleration.add(
        evaluateByParameterVector(
          this.options.acceleration ?? new THREE.Vector3(),
          time,
        ),
      );
    }, {
      ...options,
      priority: Module.Priority.PreMovementTransient,
      modifyGPU: (particle) => {
          const time = this.getDepthTimeGPU(particle.position);

          particle.position.assign(
            particle.position.add(evaluateByParameterVectorGPU(
              this.options.position ?? new THREE.Vector3(),
              time,
            )),
          );
          particle.velocity.assign(
            particle.velocity.add(evaluateByParameterVectorGPU(
              this.options.velocity ?? new THREE.Vector3(),
              time,
            )),
          );
          particle.acceleration.assign(
            particle.acceleration.add(evaluateByParameterVectorGPU(
              this.options.acceleration ?? new THREE.Vector3(),
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

export default VelocityByDepth;
