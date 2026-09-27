attribute vec4 instanceSpriteData;

varying vec4 vColor;
varying float aspectRatio;
varying float angle;
varying float vDistortionStrength;
varying vec2 vSpriteUv;

varying vec3 vViewPosition;
varying vec3 vNormal;
varying vec3 vWorldPosition;

flat out int fragFrame;

void main()
{
    #ifdef USE_INSTANCING_COLOR
    vec3 particleColor = instanceColor;
    #else
    vec3 particleColor = vec3(1.0);
    #endif

    #ifdef USE_INSTANCING
    mat4 particleMatrix = instanceMatrix;
    #else
    mat4 particleMatrix = mat4(1.0);
    #endif

    mat4 instanceModelMatrix =
        modelMatrix
        * particleMatrix;

    vec4 worldPosition =
        instanceModelMatrix
        * vec4(position, 1.0);

    vec4 mvPosition =
        viewMatrix
        * worldPosition;

    vColor = vec4(particleColor, instanceSpriteData.y);
    aspectRatio = 1.0;
    angle = 0.0;
    vDistortionStrength = instanceSpriteData.w;
    vSpriteUv = vec2(uv.x, 1.0 - uv.y);
    fragFrame = int(instanceSpriteData.x);
    vViewPosition = -mvPosition.xyz;
    vWorldPosition = worldPosition.xyz;
    vNormal = normalize(mat3(viewMatrix * instanceModelMatrix) * normal);

    gl_Position =
        projectionMatrix
        * mvPosition;
}
