// Materials. Architecture, debris and water all read the same LIGHT_GLSL rig, so
// a chunk tumbling through a cove strip picks up the rake exactly as the wall it
// came out of does. That consistency is most of why authored destruction reads as
// part of the room rather than as spawned props.

import * as THREE from 'three';
import { LIGHT_GLSL } from './lighting.js';

const VERT_COMMON = /* glsl */`
	varying vec3 vWorld;
	varying vec3 vNrm;
`;

// ---------------------------------------------------------------------------
// Architecture: tiled surfaces with a wainscot break, wet floors, fogged.
// ---------------------------------------------------------------------------

export function createSurfaceMaterial( rig, opts = {} ) {

	const uniforms = Object.assign( {}, rig.uniforms, {
		uTileScale: { value: opts.tileScale ?? 3.2 },
		uGroutWidth: { value: opts.groutWidth ?? 1.1 },
		uUpper: { value: new THREE.Color( opts.upper ?? 0xb9c9c6 ) },
		uLower: { value: new THREE.Color( opts.lower ?? 0x10171b ) },
		uGrout: { value: new THREE.Color( opts.grout ?? 0x05080a ) },
		uWainscot: { value: opts.wainscot ?? 0 },
		uWainscotBlend: { value: opts.wainscotBlend ?? 0.06 },
		uGloss: { value: opts.gloss ?? 0.55 },
		uSpecular: { value: opts.specular ?? 0.5 },
		uStreak: { value: opts.streak ?? 0.0 }
	} );

	return new THREE.ShaderMaterial( {
		uniforms,
		vertexShader: VERT_COMMON + /* glsl */`
			void main() {
				vec4 wp = modelMatrix * vec4( position, 1.0 );
				vWorld = wp.xyz;
				vNrm = normalize( mat3( modelMatrix ) * normal );
				gl_Position = projectionMatrix * viewMatrix * wp;
			}
		`,
		fragmentShader: VERT_COMMON + LIGHT_GLSL + /* glsl */`
			uniform float uTileScale;
			uniform float uGroutWidth;
			uniform vec3  uUpper;
			uniform vec3  uLower;
			uniform vec3  uGrout;
			uniform float uWainscot;
			uniform float uWainscotBlend;
			uniform float uGloss;
			uniform float uSpecular;
			uniform float uStreak;
			uniform vec3  uCamPos;

			void main() {
				vec3 N = normalize( vNrm );

				// The wainscot line is where the light lives in both references:
				// pale tile above, near-black below, the strip sitting on the join.
				float band = smoothstep( uWainscot - uWainscotBlend, uWainscot + uWainscotBlend, vWorld.y );
				vec3 base = mix( uLower, uUpper, band );

				float grout = tileGrout( vWorld, N, uTileScale, uGroutWidth );
				vec3 albedo = mix( base, uGrout, grout * 0.85 );

				// Vertical staining on walls — the first reference is entirely
				// this: a hot grazing light finding forty years of drip marks.
				if ( uStreak > 0.0 && abs( N.y ) < 0.6 ) {
					float s = fract( sin( floor( vWorld.x * 7.0 + vWorld.z * 7.0 ) * 12.9898 ) * 43758.5453 );
					float streak = smoothstep( 0.72, 1.0, s ) * smoothstep( 0.0, 3.0, vWorld.y - uWainscot );
					albedo *= 1.0 - streak * uStreak;
				}

				Surface s;
				s.pos = vWorld;
				s.normal = N;
				s.albedo = albedo;
				// Floors read wet; walls read dry unless they are below the line.
				s.gloss = mix( uGloss, min( uGloss + 0.35, 0.98 ), clamp( N.y, 0.0, 1.0 ) );
				s.specular = uSpecular * ( 1.0 - grout * 0.7 );

				vec3 color = directLighting( s, uCamPos );
				color += causticLight( s );
				color += volumetric( uCamPos, vWorld );
				color = applyFog( color, uCamPos, vWorld );

				gl_FragColor = vec4( color, 1.0 );
			}
		`
	} );

}

// ---------------------------------------------------------------------------
// Debris. Instanced, with two per-instance channels:
//   aHeat — thermal bloom, the single readout for telekinetic ownership (§10.7)
//   aTint — material colour, so a chunk keeps the surface it broke off
// ---------------------------------------------------------------------------

export function createDebrisMaterial( rig ) {

	const uniforms = Object.assign( {}, rig.uniforms, {
		uHeatColor: { value: new THREE.Color( 0xff8a3c ) },
		uCamPos: rig.uniforms.uCamPos
	} );

	return new THREE.ShaderMaterial( {
		uniforms,
		vertexShader: /* glsl */`
			attribute float aHeat;
			attribute vec3 aTint;
			varying vec3 vWorld;
			varying vec3 vNrm;
			varying float vHeat;
			varying vec3 vTint;

			void main() {
				mat4 m = modelMatrix * instanceMatrix;
				vec4 wp = m * vec4( position, 1.0 );
				vWorld = wp.xyz;
				vNrm = normalize( mat3( m ) * normal );
				vHeat = aHeat;
				vTint = aTint;
				gl_Position = projectionMatrix * viewMatrix * wp;
			}
		`,
		fragmentShader: LIGHT_GLSL + /* glsl */`
			varying vec3 vWorld;
			varying vec3 vNrm;
			varying float vHeat;
			varying vec3 vTint;
			uniform vec3 uHeatColor;
			uniform vec3 uCamPos;

			void main() {
				vec3 N = normalize( vNrm );

				Surface s;
				s.pos = vWorld;
				s.normal = N;
				s.albedo = vTint;
				s.gloss = 0.35;
				s.specular = 0.35;

				vec3 color = directLighting( s, uCamPos );
				color += causticLight( s );

				// Thermal bloom. Held mass glows; contested mass glows harder.
				// Same vocabulary as stealth, no new UI (§10.7, §26.1).
				float rim = pow( 1.0 - abs( dot( N, normalize( uCamPos - vWorld ) ) ), 2.0 );
				color += uHeatColor * vHeat * ( 0.45 + rim * 1.6 );

				color += volumetric( uCamPos, vWorld );
				color = applyFog( color, uCamPos, vWorld );

				gl_FragColor = vec4( color, 1.0 );
			}
		`
	} );

}

// ---------------------------------------------------------------------------
// Water. The brightest thing in the room and the reason anything else is
// visible — an emissive caustic sheet, not a reflective surface.
// ---------------------------------------------------------------------------

export function createWaterMaterial( rig ) {

	const uniforms = Object.assign( {}, rig.uniforms, {
		uDeep: { value: new THREE.Color( 0x03201c ) },
		uCamPos: rig.uniforms.uCamPos
	} );

	return new THREE.ShaderMaterial( {
		uniforms,
		transparent: false,
		vertexShader: VERT_COMMON + /* glsl */`
			void main() {
				vec4 wp = modelMatrix * vec4( position, 1.0 );
				vWorld = wp.xyz;
				vNrm = normalize( mat3( modelMatrix ) * normal );
				gl_Position = projectionMatrix * viewMatrix * wp;
			}
		`,
		fragmentShader: VERT_COMMON + LIGHT_GLSL + /* glsl */`
			uniform vec3 uDeep;
			uniform vec3 uCamPos;

			void main() {
				float c = caustic( vWorld.xz * uCausticScale * 1.6, uTime * 0.3 );
				float c2 = caustic( vWorld.xz * uCausticScale * 0.7 + 11.0, uTime * 0.19 );
				vec3 color = uDeep + uCausticColor * ( c * 0.9 + c2 * 0.45 ) * uCausticStrength;

				color = applyFog( color, uCamPos, vWorld );
				gl_FragColor = vec4( color, 1.0 );
			}
		`
	} );

}

// Unlit emitter for the visible body of a fixture. Kept separate and deliberately
// simple: this is the thing bloom latches onto.
export function createEmitterMaterial( color, intensity = 3 ) {

	return new THREE.MeshBasicMaterial( {
		color: new THREE.Color( color ).multiplyScalar( intensity ),
		fog: false,
		toneMapped: true
	} );

}
