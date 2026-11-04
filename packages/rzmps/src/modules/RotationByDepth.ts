import type { Vector3Input } from '../types/ValueInput';
import * as THREE from 'three';
import Module, { type ModuleExecutionContext, ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { ValueByParameter } from '../types/ValueByParameter';
import type { Node } from 'three/webgpu';
import { uniform } from 'three/tsl';
import evaluateByParameterVector from '../helpers/evaluateByParameterVector3';

export interface RotationByDepthOptions extends Partial<ModuleOptions> {
  /** Angular values are radians; scalar inputs expand uniformly across axes. */
  angle: ValueByParameter<Vector3Input>;
  angularVelocity: ValueByParameter<Vector3Input>;
  angularAcceleration: ValueByParameter<Vector3Input>;
  /** Camera-distance interval mapped to zero through one; omitted endpoints use camera near/far when available. */
  depthRange?: [number, number];
}

/**
 * Adds angular channels using distance from the captured camera, normalized over depthRange; two-value parameter
 * ranges interpolate rather than randomly sample.
 */
class RotationByDepth extends Module {
  cameraPosition: THREE.Vector3 = new THREE.Vector3();
  private readonly _gpuCameraPosition = uniform(this.cameraPosition, 'vec3');
  private readonly _gpuDepthRange = uniform(new THREE.Vector2(), 'vec2');
  depthRange?: [number, number];

  private _cameraDepthRange: [number, number] = [0, 100];

  /** Creates the modifier with its built-in priority and optional filtering/LOD settings. */
  constructor(public options: Partial<RotationByDepthOptions> = {}) {

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

      particle.rotation.add(
        evaluateByParameterVector(
          this.options.angle ?? new THREE.Vector3(),
          time,
        ),
      );
      particle.angularVelocity.add(
        evaluateByParameterVector(
          this.options.angularVelocity ?? new THREE.Vector3(),
          time,
        ),
      );
      particle.angularAcceleration.add(
        evaluateByParameterVector(
          this.options.angularAcceleration ?? new THREE.Vector3(),
          time,
        ),
      );
    }, {
      ...options,
      priority: Module.Priority.PreMovementTransient,
      modifyGPU: (particle) => {
          const time = this.getDepthTimeGPU(particle.position);

          particle.rotation.assign(
            particle.rotation.add(this.gpuParameters.parameterVector(
              'angle', () => this.options.angle,
              time,
            )),
          );
          particle.angularVelocity.assign(
            particle.angularVelocity.add(this.gpuParameters.parameterVector(
              'angularVelocity', () => this.options.angularVelocity,
              time,
            )),
          );
          particle.angularAcceleration.assign(
            particle.angularAcceleration.add(this.gpuParameters.parameterVector(
              'angularAcceleration', () => this.options.angularAcceleration,
              time,
            )),
          );
        }
    });

    this.depthRange = options.depthRange;
  }

  public prepare(context: ModuleExecutionContext): void {
    const { system: particleSystem } = context;
    super.prepare(context);
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

export default RotationByDepth;
