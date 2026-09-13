attribute vec3 scale;
attribute vec3 rotation;
attribute float frame;

varying vec4 vColor;
varying float aspectRatio;
varying float angle;

varying vec3 vViewPosition;
varying vec3 vNormal;

flat out int fragFrame;

void main()
{
    vColor = color;
    angle = rotation.x;

    vec4 mvPosition =
        modelViewMatrix
        * vec4(position, 1.0);

    aspectRatio =
        float(scale.y)
        / float(scale.x);

    gl_PointSize =
        max(scale.x, scale.y)
        * (300.0 / -mvPosition.z);

    gl_Position =
        projectionMatrix
        * mvPosition;

    fragFrame =
        int(frame);

    // Match Three's convention:
    // vector from fragment toward camera.
    vViewPosition =
        -mvPosition.xyz;

    // Point sprites always face the camera,
    // so their base normal in view space points forward.
    vNormal =
        vec3(0.0, 0.0, 1.0);
}
