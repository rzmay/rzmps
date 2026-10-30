import * as THREE from 'three';
import Module, { ModuleOptions } from '../Module';
import Particle from '../Particle';
import type ParticleSystem from '../ParticleSystem';
import type { ValueByParameter } from '../types/ValueByParameter';
import type { Node } from 'three/webgpu';
import { uniform } from 'three/tsl';
import evaluateByParameterVector from '../helpers/evaluateByParameterVector3';

export interface VelocityByDepthOptions extends Partial<ModuleOptions> {
  position: ValueByParameter<THREE.Vector3>;
  velocity: ValueByParameter<THREE.Vector3>;
  acceleration: ValueByParameter<THREE.Vector3>;
  /** Camera-distance interval mapped to zero through one; omitted endpoints use camera near/far when available. */
  depthRange?: [number, number];
}

/**
 * Adds linear motion channels using distance from the captured camera, normalized over depthRange; two-value parameter
 * ranges interpolate rather than randomly sample.
 */
class VelocityByDepth extends Module {
  cameraPosition: THREE.Vector3 = new THREE.Vector3();
  private readonly _gpuCameraPosition = uniform(this.cameraPosition, 'vec3');
  private readonly _gpuDepthRange = uniform(new THREE.Vector2(), 'vec2');
  depthRange?: [number, number];

  private _cameraDepthRange: [number, number] = [0, 100];

  /** Creates the modifier with its built-in priority and optional filtering/LOD settings. */
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
            particle.position.add(this.gpuParameters.parameterVector(
              'position', () => this.options.position,
              time,
            )),
          );
          particle.velocity.assign(
            particle.velocity.add(this.gpuParameters.parameterVector(
              'velocity', () => this.options.velocity,
              time,
            )),
          );
          particle.acceleration.assign(
            particle.acceleration.add(this.gpuParameters.parameterVector(
              'acceleration', () => this.options.acceleration,
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
        particleSystem.worldToSimulation(this.cameraPosition);
      }

      if (camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera) {
        this._cameraDepthRange = [camera.near, camera.far];
      }
    }
    this._gpuDepthRange.value.set(
      this.depthRange?.[0] ?? this._cameraDepthRange[0],
      this.depthRange?.[1] ?? this._cameraDepthRange[1],
    );
  }

  private getDepthTimeGPU(position: Node<'vec3'>) {
    return position.sub(this._gpuCameraPosition).length().sub(this._gpuDepthRange.x)
      .div(this._gpuDepthRange.y.sub(this._gpuDepthRange.x).max(Number.EPSILON)).clamp(0, 1);
  }
}

export default VelocityByDepth;
