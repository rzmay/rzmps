precision highp float;

// Standard transform and position declarations are supplied by ShaderMaterial.

out vec3 vOrigin;
out vec3 vDirection;

void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);

  vOrigin = vec3(inverse(modelMatrix) * vec4(cameraPosition, 1.0));
  vDirection = position - vOrigin;

  gl_Position = projectionMatrix * mvPosition;
}
