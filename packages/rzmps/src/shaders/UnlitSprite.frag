uniform sampler2D pointTexture;
uniform sampler2D alphaMap;
uniform bool hasAlphaMap;
uniform vec2 gridSize;
uniform int n_frames;

uniform float transmission;
uniform sampler2D transmissionMap;
uniform bool hasTransmissionMap;

uniform sampler2D distortionMap;
uniform bool hasDistortionMap;
uniform float distortionStrength;

uniform bool softParticles;
uniform float softParticleDistance;

uniform sampler2D sceneColorTexture;
uniform vec2 sceneColorResolution;

uniform sampler2D sceneDepthTexture;
uniform vec2 depthResolution;
uniform float depthCameraNear;
uniform float depthCameraFar;

varying vec4 vColor;
varying float aspectRatio;
varying float angle;
varying float vDistortionStrength;

flat in int fragFrame;

#include <packing>

vec2 sprite_coord(vec2 coord, int frame)
{
    float f_frame =
        mod(float(frame), float(n_frames));

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

vec2 rotate_vector(vec2 value, float rotation)
{
    return vec2(
        cos(rotation) * value.x
            + sin(rotation) * value.y,

        cos(rotation) * value.y
            - sin(rotation) * value.x
    );
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

    vec2 fromCenter =
        gl_PointCoord - vec2(0.5);

    vec2 rotatedFromCenter =
        rotate_vector(
            fromCenter,
            angle
        );

    vec2 scaledFromCenter =
        rotatedFromCenter
        * scaleVector;

    vec2 rotatedLocalCoord =
        vec2(0.5)
        + scaledFromCenter;

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
        texture2D(
            pointTexture,
            spriteCoord
        );

    vec4 baseColor =
        vColor * textureColor;

    if (hasAlphaMap)
    {
        vec4 alphaSample =
            texture2D(
                alphaMap,
                spriteCoord
            );

        baseColor.a *=
            alphaSample.r
            * alphaSample.a;
    }

    //
    // TRANSMISSION / DISTORTION
    //

    float transmissionValue =
        transmission;

    if (hasTransmissionMap)
    {
        transmissionValue *=
            texture2D(
                transmissionMap,
                spriteCoord
            ).r;
    }

    transmissionValue =
        clamp(
            transmissionValue,
            0.0,
            1.0
        );

    vec2 distortion =
        vec2(0.0);

    if (
        transmissionValue > 0.0
        && hasDistortionMap
    )
    {
        vec3 distortionNormal =
            texture2D(
                distortionMap,
                spriteCoord
            ).xyz
            * 2.0
            - 1.0;

        distortion =
            rotate_vector(
                distortionNormal.xy,
                angle
            );
    }

    //
    // SOFT PARTICLES
    //

    float finalAlpha =
        baseColor.a;

    if (softParticles)
    {
        float particleViewZ =
            perspectiveDepthToViewZ(
                gl_FragCoord.z,
                depthCameraNear,
                depthCameraFar
            );

        vec2 screenUv =
            gl_FragCoord.xy
            / depthResolution;

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
            abs(
                particleViewZ
                - sceneViewZ
            );

        float softFade =
            smoothstep(
                0.0,
                softParticleDistance,
                depthDifference
            );

        finalAlpha *=
            softFade;
    }

    if (finalAlpha <= 0.0)
    {
        discard;
    }

    //
    // FINAL COLOR
    //

    vec3 finalColor =
        baseColor.rgb;

    if (transmissionValue > 0.0)
    {
        vec2 colorResolution =
            max(
                sceneColorResolution,
                vec2(1.0)
            );

        vec2 screenUv =
            gl_FragCoord.xy
            / colorResolution;

        // finalAlpha controls BOTH:
        //
        // 1. framebuffer contribution through output alpha
        // 2. actual refraction displacement
        //
        // So heat distortion smoothly collapses toward the
        // undistorted background as the particle fades.
        // Importantly, to avoid ghosting/background doubling,
        // if there is any transmission, alpha should control
        // that rather than actually using alpha blending
        vec2 distortionUv =
            distortion
            * distortionStrength
            * vDistortionStrength
            * finalAlpha
            / colorResolution;

        vec3 transmittedColor =
            texture2D(
                sceneColorTexture,
                screenUv
                    + distortionUv
            ).rgb;

        transmissionValue = 1.0 - ((1.0 - transmissionValue) * finalAlpha);
        finalAlpha = 1.0;

        finalColor =
            mix(
                baseColor.rgb,
                transmittedColor,
                transmissionValue
            );
    }

    gl_FragColor =
        vec4(
            finalColor,
            finalAlpha
        );
}
