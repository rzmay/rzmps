attribute vec4 scale;
attribute vec3 rotation;
attribute float frame;

uniform float viewportHeight;

varying vec4 vColor;
varying float aspectRatio;
varying float angle;
flat out int fragFrame;

void main() {

    vColor = color;

    angle = rotation.x;

    vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );

    aspectRatio = float(scale.y) / float(scale.x);

    float projectionScale =
        projectionMatrix[1][1]
        * viewportHeight
        * 0.5;

    float perspectiveScale =
        projectionMatrix[3][3] == 0.0
            ? 1.0 / -mvPosition.z
            : 1.0;

    gl_PointSize =
        max(scale.x, scale.y)
        * projectionScale
        * perspectiveScale;

    gl_Position = projectionMatrix * mvPosition;

    fragFrame = int(frame);

}
