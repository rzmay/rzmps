attribute vec4 scale;
attribute vec3 spriteData;

uniform float viewportHeight;
uniform bool sizeAttenuation;

varying vec4 vColor;
varying float aspectRatio;
varying float angle;
varying float vDistortionStrength;
varying vec2 vDistortionWorldToUv;
varying vec2 vSpriteUv;
flat out int fragFrame;

void main() {

    vColor = color;

    angle = spriteData.x;
    vDistortionStrength = spriteData.z;
    vSpriteUv = vec2(0.0);

    vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );

    vec2 spriteScale = abs(scale.xy);

    aspectRatio = spriteScale.y / spriteScale.x;

    float projectionScale =
        projectionMatrix[1][1]
        * viewportHeight
        * 0.5;

    float perspectiveScale =
        sizeAttenuation && projectionMatrix[3][3] == 0.0
            ? 1.0 / -mvPosition.z
            : 1.0;

    float distortionPerspectiveScale =
        projectionMatrix[3][3] == 0.0
            ? 1.0 / max(-mvPosition.z, 0.0001)
            : 1.0;

    vDistortionWorldToUv =
        vec2(projectionMatrix[0][0], projectionMatrix[1][1])
        * 0.5
        * distortionPerspectiveScale;

    gl_PointSize =
        max(spriteScale.x, spriteScale.y)
        * projectionScale
        * perspectiveScale;

    gl_Position = projectionMatrix * mvPosition;

    fragFrame = int(spriteData.y);

}
