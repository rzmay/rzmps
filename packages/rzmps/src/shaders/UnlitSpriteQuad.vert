attribute vec4 instanceSpriteData;

varying vec4 vColor;
varying float aspectRatio;
varying float angle;
varying float vDistortionStrength;
varying vec2 vDistortionWorldToUv;
varying vec2 vSpriteUv;
flat out int fragFrame;

void main()
{
    #ifdef USE_INSTANCING_COLOR
    vec3 particleColor = instanceColor;
    #else
    vec3 particleColor = vec3(1.0);
    #endif

    vColor = vec4(particleColor, instanceSpriteData.y);
    aspectRatio = 1.0;
    angle = 0.0;
    vDistortionStrength = instanceSpriteData.w;
    vSpriteUv = vec2(uv.x, 1.0 - uv.y);
    fragFrame = int(instanceSpriteData.x);

    #ifdef USE_INSTANCING
    mat4 particleMatrix = instanceMatrix;
    #else
    mat4 particleMatrix = mat4(1.0);
    #endif

    vec4 centerViewPosition =
        viewMatrix
        * modelMatrix
        * particleMatrix
        * vec4(0.0, 0.0, 0.0, 1.0);

    float distortionPerspectiveScale =
        projectionMatrix[3][3] == 0.0
            ? 1.0 / max(-centerViewPosition.z, 0.0001)
            : 1.0;

    vDistortionWorldToUv =
        vec2(projectionMatrix[0][0], projectionMatrix[1][1])
        * 0.5
        * distortionPerspectiveScale;

    gl_Position =
        projectionMatrix
        * viewMatrix
        * modelMatrix
        * particleMatrix
        * vec4(position, 1.0);
}
