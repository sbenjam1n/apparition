// Post-processing.
//
// The stack, the final-pass shader and its parameter defaults are adapted from
// the "Fly in Particles City" pen (MIT, (c) 2026 Sabo Sugi) — bloom, afterimage
// trails, then radial chromatic aberration + scanline + luminance-weighted
// temporal grain + vignette, under ACES.
//
// One deliberate departure. The pen runs chromatic shift as a constant baseline
// look. §44.9 reserves chroma bleed absolutely, for erasure and nothing else:
// "the moment it becomes a look, it stops being a wound." So the uniform is
// wired and reactive but sits at zero, and `erase()` is the only thing that
// opens it. Everything else the pen does is kept as the house style.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ACC } from './accretion.js';

const _size = new THREE.Vector2();

export const POST = {
	bloomStrength: 0.5,
	bloomRadius: 0.82,
	bloomThreshold: 0.85,
	trailPersistence: 0.0,     // opened by dilation, not by default
	chromaticShift: 0.0,       // §44.9 — erasure only
	grain: 0.035,
	vignette: 0.58,
	scanline: 0.015,
	exposure: 1.0
};

const FinalShader = {
	uniforms: {
		tDiffuse: { value: null },
		uTime: { value: 0 },
		uFrame: { value: 0 },
		uResolution: { value: new THREE.Vector2( 1, 1 ) },
		uPixelRatio: { value: 1 },
		uChromaticShift: { value: POST.chromaticShift },
		uGrain: { value: POST.grain },
		uVignette: { value: POST.vignette },
		uScanline: { value: POST.scanline }
	},
	vertexShader: /* glsl */`
		varying vec2 vUv;
		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
		}
	`,
	fragmentShader: /* glsl */`
		uniform sampler2D tDiffuse;
		uniform float uTime;
		uniform float uFrame;
		uniform vec2 uResolution;
		uniform float uPixelRatio;
		uniform float uChromaticShift;
		uniform float uGrain;
		uniform float uVignette;
		uniform float uScanline;
		varying vec2 vUv;

		float pixelHash( vec2 p ) {
			vec3 v = fract( vec3( p.x, p.y, p.x ) * vec3( 0.1031, 0.1030, 0.0973 ) );
			v += dot( v, v.yzx + 33.33 );
			return fract( ( v.x + v.y ) * v.z );
		}

		void main() {
			vec2 centered = vUv - 0.5;
			float radial = dot( centered, centered );
			vec3 color;

			if ( uChromaticShift > 0.0 ) {
				vec2 direction = normalize( centered + vec2( 0.00001 ) );
				float shift = uChromaticShift * ( 0.42 + radial * 2.6 );
				color = vec3(
					texture2D( tDiffuse, vUv + direction * shift ).r,
					texture2D( tDiffuse, vUv ).g,
					texture2D( tDiffuse, vUv - direction * shift ).b
				);
			} else {
				color = texture2D( tDiffuse, vUv ).rgb;
			}

			float effectivePixelRatio = max( uPixelRatio, 1.0 );
			vec2 safeResolution = max( uResolution, vec2( 1.0 ) );
			vec2 cssResolution = max( floor( safeResolution / effectivePixelRatio ), vec2( 1.0 ) );
			vec2 nf = clamp( gl_FragCoord.xy / safeResolution, vec2( 0.0 ), vec2( 1.0 ) );
			vec2 cssPixel = floor( nf * cssResolution );

			float scan = sin( ( gl_FragCoord.y / effectivePixelRatio + uTime * 42.0 ) * 3.14159265 ) * 0.5 + 0.5;
			color *= 1.0 - uScanline + scan * uScanline;

			vec2 temporal = vec2( mod( uFrame * 37.0, 4096.0 ), mod( uFrame * 61.0, 4096.0 ) );
			float grain = pixelHash( cssPixel + temporal ) - 0.5;
			float luminance = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
			color += grain * uGrain * ( 0.3 + 0.7 * clamp( luminance, 0.0, 1.0 ) );

			float vignette = smoothstep( 0.92, 0.18, radial * ( 1.05 + uVignette ) );
			color *= mix( 1.0, vignette, uVignette );

			gl_FragColor = vec4( max( color, 0.0 ), 1.0 );
		}
	`
};

export class PostStack {

	constructor( renderer, scene, camera ) {

		this.renderer = renderer;
		this.frame = 0;

		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = POST.exposure;
		renderer.outputColorSpace = THREE.SRGBColorSpace;

		this.composer = new EffectComposer( renderer );
		this.renderPass = new RenderPass( scene, camera );

		// The resolution passed here is only a seed — setSize below is what every
		// pass actually ends up sized by, and it is driven from one place.
		this.bloom = new UnrealBloomPass(
			renderer.getDrawingBufferSize( _size ).clone(),
			POST.bloomStrength, POST.bloomRadius, POST.bloomThreshold );
		this.afterimage = new AfterimagePass();
		this.afterimage.uniforms.damp.value = POST.trailPersistence;
		this.afterimage.enabled = false;

		this.final = new ShaderPass( FinalShader );
		this.output = new OutputPass();

		this.composer.addPass( this.renderPass );
		this.composer.addPass( this.bloom );
		this.composer.addPass( this.afterimage );
		this.composer.addPass( this.final );
		this.composer.addPass( this.output );

		this._erasure = 0;

	}

	// Every pass has to agree on one size, and the only authority is the
	// renderer's drawing buffer.
	//
	// Hand-computing it went wrong in two ways at any pixel ratio below 1. The
	// composer owns its own ratio, so `composer.setSize(w, h)` allocated targets
	// at w x h while the screen buffer was 0.85w — and `bloom.setSize(w*dpr,...)`
	// then re-sized the bloom a second time, after composer.setSize had already
	// propagated to it, so the bloom blurred a 1024-wide texture with kernels
	// built for 870. That mismatch is what put banded rectangles in the frame.
	//
	// uResolution was the other half: at 870.4 against a 1024-wide target, the
	// grain's normalised coordinate clamped to 1.0 across everything past 870,
	// freezing the hash to a single value over whole bands. Taking the size from
	// getDrawingBufferSize keeps it integral and keeps it true.
	setSize( w, h, dpr ) {

		this.composer.setPixelRatio( dpr );
		this.composer.setSize( w, h );

		this.renderer.getDrawingBufferSize( _size );
		this.final.uniforms.uResolution.value.copy( _size );
		this.final.uniforms.uPixelRatio.value = dpr;

	}

	// The one sanctioned use of the chroma channel. Scarcity is the entire value.
	erase( amount = 1 ) {

		this._erasure = Math.max( this._erasure, amount );

	}

	// Bloom breathes with draw rather than on a timer: spending watts is what
	// makes you bright, and being bright is what gets you found (§5.1).
	update( dt, elapsed, { watts = 0, heat = 0, dilation = 0 } = {} ) {

		// Wrapped, because the grain's temporal offset is mod(frame*61, 4096) and
		// float32 stops representing integers exactly past 2^24. Left unbounded,
		// frame*61 crosses that after about two hours of running and the offset
		// quantises — the grain stops moving and starts sitting still. Wrapping at
		// 65536 keeps every product exact; the pattern repeats every 18 minutes,
		// which nobody will ever see.
		this.frame = ( this.frame + 1 ) % 65536;

		const load = Math.min( 1, watts / ACC.wattScale );
		this.bloom.strength = POST.bloomStrength * ( 1 + load * 0.55 + Math.min( heat / 100, 1 ) * 0.25 );

		// Trails belong to dilation — a charging phase whose payload lands when
		// you drop the clock (§10.4). Off entirely at 1:1.
		if ( dilation > 0.01 ) {

			this.afterimage.enabled = true;
			this.afterimage.uniforms.damp.value = Math.min( 0.72, dilation * 0.72 );

		} else {

			this.afterimage.enabled = false;

		}

		this._erasure = Math.max( 0, this._erasure - dt * 1.8 );
		this.final.uniforms.uChromaticShift.value = this._erasure * 0.006;

		this.final.uniforms.uTime.value = elapsed;
		this.final.uniforms.uFrame.value = this.frame;
		this.final.uniforms.uGrain.value = POST.grain;
		this.final.uniforms.uVignette.value = POST.vignette;
		this.final.uniforms.uScanline.value = POST.scanline;
		this.renderer.toneMappingExposure = POST.exposure;

	}

	render( dt ) {

		this.composer.render( dt );

	}

}
