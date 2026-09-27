attribute vec4 instanceSpriteData;

varying vec4 vColor;
varying float aspectRatio;
varying float angle;
varying float vDistortionStrength;
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

    gl_Position =
        projectionMatrix
        * viewMatrix
        * modelMatrix
        * particleMatrix
        * vec4(position, 1.0);
}
