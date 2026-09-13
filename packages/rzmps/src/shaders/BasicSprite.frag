uniform sampler2D pointTexture;

uniform sampler2D alphaMap;
uniform bool hasAlphaMap;

uniform sampler2D normalMap;
uniform bool hasNormalMap;
uniform float normalStrength;

uniform float normalLighting;
uniform bool sphericalNormals;

uniform float roughness;
uniform sampler2D roughnessMap;
uniform bool hasRoughnessMap;

uniform vec2 gridSize;
uniform int n_frames;

uniform sampler2D envMap;
uniform float envIntensity;
uniform bool hasEnvMap;

uniform bool softParticles;
uniform float softParticleDistance;
uniform sampler2D sceneDepthTexture;
uniform vec2 depthResolution;
uniform float depthCameraNear;
uniform float depthCameraFar;

varying vec4 vColor;
varying float aspectRatio;
varying float angle;

varying vec3 vViewPosition;
varying vec3 vNormal;

flat in int fragFrame;

// Provides:
// IncidentLight
// ReflectedLight
// saturate()
// pow2(), pow4(), etc.
#include <common>

// Provides:
// ambientLightColor
// directionalLights[]
// pointLights[]
// spotLights[]
// hemisphereLights[]
// getDirectionalLightInfo()
// getPointLightInfo()
// getSpotLightInfo()
#include <lights_pars_begin>

// Provides PMREM environment decoding
#include <cube_uv_reflection_fragment>

// perspectiveDepthToViewZ
#include <packing>


vec2 rotate_vector(vec2 value, float rotation)
{
    return vec2(
        cos(rotation) * value.x + sin(rotation) * value.y,
        cos(rotation) * value.y - sin(rotation) * value.x
    );
}


vec2 sprite_coord(vec2 coord, int frame)
{
    float f_frame = mod(float(frame), float(n_frames));

    return vec2(
        (coord.x / gridSize.x)
            + (
                mod(f_frame, gridSize.x)
                * (1.0 / gridSize.x)
            ),

        1.0 - (
            (coord.y / gridSize.y)
            + (
                floor(f_frame / gridSize.x)
                * (1.0 / gridSize.y)
            )
        )
    );
}

vec2 directionToEquirectUv(vec3 dir)
{
    dir = normalize(dir);

    return vec2(
        atan(dir.z, dir.x) / (2.0 * PI) + 0.5,
        asin(clamp(dir.y, -1.0, 1.0)) / PI + 0.5
    );
}


void accumulateLight(
    IncidentLight light,
    vec3 normal,
    vec3 viewDirection,
    float shininess,
    float specularStrength,
    float normalLighting,
    inout vec3 diffuseLight,
    inout vec3 specularLight
)
{
    if (!light.visible)
        return;

    float normalDiffuse =
        max(dot(normal, light.direction), 0.0);

    float diffuseFactor =
        mix(1.0, normalDiffuse, normalLighting);

    diffuseLight +=
        light.color * diffuseFactor;

    if (normalLighting > 0.0 && normalDiffuse > 0.0)
    {
        vec3 halfDirection =
            normalize(light.direction + viewDirection);

        float specular =
            pow(
                max(dot(normal, halfDirection), 0.0),
                shininess
            );

        specularLight +=
            light.color
            * specular
            * specularStrength
            * normalLighting;
    }
}


void main()
{
    //
    // SPRITE UV
    //

    vec2 scaleVector;

    if (aspectRatio < 1.0 / aspectRatio)
    {
        scaleVector =
            vec2(1.0, 1.0 / aspectRatio);
    }
    else
    {
        scaleVector =
            vec2(aspectRatio, 1.0);
    }

    // Transform in LOCAL TILE coordinates first.
    vec2 fromCenter =
        gl_PointCoord - vec2(0.5);

    // Undo the particle rotation in the square point-sprite space FIRST.
    vec2 rotatedFromCenter =
        rotate_vector(fromCenter, angle);

    // Then account for the non-square sprite dimensions.
    vec2 scaledFromCenter =
        rotatedFromCenter * scaleVector;

    vec2 rotatedLocalCoord =
        vec2(0.5) + scaledFromCenter;

    // Rotation can push us outside this sprite's tile.
    // Discard rather than sampling an adjacent tile.
    if (
        rotatedLocalCoord.x < 0.0
        || rotatedLocalCoord.x > 1.0
        || rotatedLocalCoord.y < 0.0
        || rotatedLocalCoord.y > 1.0
    )
    {
        discard;
    }

    vec2 spriteCoord =
        sprite_coord(
            rotatedLocalCoord,
            fragFrame
        );


    //
    // BASE COLOR / ALPHA
    //

    vec4 textureColor =
        texture2D(pointTexture, spriteCoord);

    vec4 baseColor =
        vColor * textureColor;

    if (hasAlphaMap)
    {
        baseColor.a *=
            texture2D(alphaMap, spriteCoord).r;
    }

    if (baseColor.a <= 0.0)
        discard;


    //
    // NORMAL
    //

    vec3 normal =
        normalize(vNormal);

    if (sphericalNormals)
    {
        vec2 p =
            rotatedLocalCoord * 2.0 - 1.0;

        float r2 = dot(p, p);

        if (r2 <= 1.0)
        {
            normal = normalize(vec3(
                p.x,
                -p.y,
                sqrt(1.0 - r2)
            ));
        }
    }

    if (hasNormalMap)
    {
        vec3 mapNormal =
            texture2D(
                normalMap,
                spriteCoord
            ).xyz * 2.0 - 1.0;

        // Normal map rotates with sprite.
        mapNormal.xy =
            rotate_vector(
                mapNormal.xy,
                angle
            );

        mapNormal.xy *= normalStrength;

        normal =
            normalize(mapNormal);
    }


    //
    // ROUGHNESS -> BLINN/PHONG PARAMETERS
    //

    float roughnessValue =
        roughness;

    if (hasRoughnessMap)
    {
        roughnessValue *=
            texture2D(
                roughnessMap,
                spriteCoord
            ).r;
    }

    roughnessValue =
        clamp(roughnessValue, 0.0, 1.0);

    // We're not implementing full PBR here.
    // Convert roughness to something sensible
    // for a Blinn-Phong highlight.
    float shininess =
        mix(128.0, 2.0, roughnessValue);

    float specularStrength =
        1.0 - roughnessValue;


    //
    // LIGHTING
    //

    vec3 viewDirection =
        normalize(vViewPosition);

    // Sample environment lighting
    vec3 environmentSpecular = vec3(0.0);
    vec3 environmentDiffuse = vec3(0.0);

    #ifdef ENVMAP_TYPE_CUBE_UV
    if (hasEnvMap && envIntensity > 0.0)
    {
        vec3 worldNormal =
            normalize(
                inverseTransformDirection(
                    normal,
                    viewMatrix
                )
            );

        vec3 worldViewDirection =
            normalize(
                inverseTransformDirection(
                    viewDirection,
                    viewMatrix
                )
            );

        vec3 reflectionDirection =
            reflect(
                -worldViewDirection,
                worldNormal
            );

        reflectionDirection =
            normalize(
                mix(
                    reflectionDirection,
                    worldNormal,
                    pow(roughnessValue, 4.0)
                )
            );

        environmentSpecular =
            textureCubeUV(
                envMap,
                reflectionDirection,
                roughnessValue
            ).rgb
            * envIntensity;

        float NdotV =
            max(dot(normal, viewDirection), 0.0);

        float fresnel =
            pow(1.0 - NdotV, 5.0);

        float specularFactor =
            mix(0.04, 1.0, fresnel);

        environmentSpecular *= specularFactor;

        environmentDiffuse =
            textureCubeUV(
                envMap,
                worldNormal,
                1.0
            ).rgb
            * envIntensity;
    }
    #endif

    // Three gives ambient light as a combined color.
    vec3 diffuseLight =
        ambientLightColor
        + environmentDiffuse;

    vec3 specularLight =
        environmentSpecular;

    IncidentLight directLight;


    //
    // DIRECTIONAL LIGHTS
    //

    #if NUM_DIR_LIGHTS > 0

        DirectionalLight directionalLight;

        #pragma unroll_loop_start

        for (
            int i = 0;
            i < NUM_DIR_LIGHTS;
            i++
        )
        {
            directionalLight =
                directionalLights[i];

            getDirectionalLightInfo(
                directionalLight,
                directLight
            );

            accumulateLight(
                directLight,
                normal,
                viewDirection,
                shininess,
                specularStrength,
                normalLighting,
                diffuseLight,
                specularLight
            );
        }

        #pragma unroll_loop_end

    #endif


    //
    // POINT LIGHTS
    //

    #if NUM_POINT_LIGHTS > 0

        PointLight pointLight;

        #pragma unroll_loop_start

        for (
            int i = 0;
            i < NUM_POINT_LIGHTS;
            i++
        )
        {
            pointLight =
                pointLights[i];

            getPointLightInfo(
                pointLight,
                -vViewPosition,
                directLight
            );

            accumulateLight(
                directLight,
                normal,
                viewDirection,
                shininess,
                specularStrength,
                normalLighting,
                diffuseLight,
                specularLight
            );
        }

        #pragma unroll_loop_end

    #endif


    //
    // SPOT LIGHTS
    //

    #if NUM_SPOT_LIGHTS > 0

        SpotLight spotLight;

        #pragma unroll_loop_start

        for (
            int i = 0;
            i < NUM_SPOT_LIGHTS;
            i++
        )
        {
            spotLight =
                spotLights[i];

            getSpotLightInfo(
                spotLight,
                -vViewPosition,
                directLight
            );

            accumulateLight(
                directLight,
                normal,
                viewDirection,
                shininess,
                specularStrength,
                normalLighting,
                diffuseLight,
                specularLight
            );
        }

        #pragma unroll_loop_end

    #endif


    //
    // HEMISPHERE LIGHTS
    //

    #if NUM_HEMI_LIGHTS > 0

        #pragma unroll_loop_start

        for (
            int i = 0;
            i < NUM_HEMI_LIGHTS;
            i++
        )
        {
            diffuseLight +=
                getHemisphereLightIrradiance(
                    hemisphereLights[i],
                    normal
                );
        }

        #pragma unroll_loop_end

    #endif

    //
    // SOFT PARTICLES
    //

    float finalAlpha = baseColor.a;

    if (softParticles)
    {
        float particleViewZ =
            perspectiveDepthToViewZ(
                gl_FragCoord.z,
                depthCameraNear,
                depthCameraFar
            );

        vec2 screenUv =
            gl_FragCoord.xy / depthResolution;

        float sceneDepth =
            texture2D(
                sceneDepthTexture,
                screenUv
            ).x;

        float sceneViewZ =
            perspectiveDepthToViewZ(
                sceneDepth,
                depthCameraNear,
                depthCameraFar
            );

        float depthDifference =
            abs(particleViewZ - sceneViewZ);

        float softFade =
            smoothstep(
                0.0,
                softParticleDistance,
                depthDifference
            );

        finalAlpha *= softFade;
    }


    //
    // FINAL COLOR
    //

    vec3 litColor =
        baseColor.rgb * diffuseLight
        + specularLight;

    gl_FragColor =
        vec4(
            litColor,
            finalAlpha
        );
}
