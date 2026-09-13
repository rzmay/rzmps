attribute vec4 scale;
attribute vec3 rotation;
attribute float frame;

varying vec4 vColor;
varying float aspectRatio;
varying float angle;
flat out int fragFrame;

void main() {

    vColor = color;

    angle = rotation.x;

    vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );

    aspectRatio = float(scale.y) / float(scale.x);

    gl_PointSize = max(scale.x, scale.y) * ( 300.0 / -mvPosition.z );

    gl_Position = projectionMatrix * mvPosition;

    fragFrame = int(frame);

}
