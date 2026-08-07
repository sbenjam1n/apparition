// Hydra.
//
// A feedback chain in the shape of Olivia Jack's hydra, which is a live-coded
// video synth built on WebGL framebuffers. The one capability being borrowed is
// the one that makes it: `src(o0)`, sampling an output's *previous frame* and
// feeding it back into itself. Hydra does that with a ping-pong pair of
// framebuffers per output — two textures alternating read and write roles each
// frame, because you cannot read and write one texture in the same pass — and
// exposes more buffers via setBufferCount() precisely to stop multi-output
// feedback period-doubling into a strobe. Same structure here, same reason.
//
// What is deliberately *not* borrowed is the live-coding half. Hydra evaluates a
// chain of JS at runtime; this compiles one fixed chain into GLSL with a uniform
// per stage. The vocabulary is the small subset that produces the look:
//
//   src(o0)          the last frame
//   modulate         warp one thing's sampling coordinates by another's
//                    brightness. This is *the* operator — almost every tendril,
//                    curl and smear in a hydra sketch is a modulate of the
//                    feedback by a slow field.
//   modulateScale    warp the zoom by the field rather than uniformly, which is
//                    the difference between a tunnel and something breathing
//   modulateRotate   same for the spiral, and where the flower shapes come from
//   kaleid(n)        radial mirroring. One line, and the biggest single change
//                    in the look — a smear becomes a bloom with n petals.
//   repeat(x,y)      tile the plane, which is where lattice and grid come from
//   rotate / scale   turn and push the tap each pass
//   pixelate         quantise the sampling grid. §48's failing resolution, for
//                    free and in the right register.
//   posterize        quantise value, which is what makes a scan read as data
//   thresh / luma    keep only what is bright, so the loop carries tendrils
//                    rather than a wash
//   colorama         rotate hue as it recirculates, so a white streak leaves a
//                    rainbow behind it rather than a grey one
//   invert / shift   per-channel inversion and offset
//   diff             difference against the live frame, which keeps edges alive
//
// The important part for a game rather than a sketch: this is not only a screen
// filter. The accumulated buffer is handed back to scan.js and shred.js as a
// texture, and points sample it *at their own previous-frame screen position* to
// displace and tint themselves. So the geometry is warped by the after-image of
// the geometry. Output becomes input at the world level, not just the frame.

import * as THREE from 'three';

export const HYDRA = {

	enabled: true,

	// --- the loop -----------------------------------------------------------
	// These sit deliberately below runaway. A screen blend has a fixed point at
	// p = 1 - (1 - feedback·p)(1 - live), and at 0.88 / 0.62 that lands around
	// 0.93 — the loop fills the frame with rolling colour in about two seconds
	// and the room disappears inside its own after-image. It is a real hydra
	// behaviour and it is worth reaching on the sliders, but it cannot be the
	// resting state of a world you have to fly through.
	feedback: 0.70,          // how much of the last frame survives into this one
	live: 0.35,              // how much of the new frame is injected
	decay: 0.02,             // bleed toward black, so it does not saturate white

	// --- the modulate -------------------------------------------------------
	// The warp field. Oscillators crossed with value noise and a voronoi term;
	// `fieldMix` slides between them, because osc alone reads as a sine and
	// voronoi alone reads as cells, and the interesting ground is between.
	modAmount: 0.004,        // UV displacement per unit brightness
	modScale: 3.1,
	modSpeed: 0.17,
	selfModulate: 0.35,      // how much the feedback warps *itself*
	fieldMix: 0.45,          // 0 = pure osc, 1 = pure voronoi
	modScaleAmount: 0.0,     // modulateScale — zoom warped by the field
	modRotateAmount: 0.0,    // modulateRotate — spiral warped by the field

	// --- the transform ------------------------------------------------------
	// kaleid is the single biggest lever in here. Zero is off; anything from
	// three up folds the tap into that many mirrored wedges and a smear becomes a
	// bloom. It is most of what the reference image is.
	kaleid: 0.0,
	repeatX: 0.0,            // 0 = off; tiles the plane, which is where lattice
	repeatY: 0.0,            //         and grid structure come from
	rotate: 0.022,           // radians per pass; the spiral
	// Exactly one is the honest default. Anything above it expands every bright
	// pixel outward on every pass, so a single lit point becomes the whole frame
	// given enough seconds — which is how tunnels are made, and also how the room
	// gets eaten.
	zoom: 1.0,               // >1 tunnels outward, <1 pulls in
	drift: 0.0,              // pushes the whole field along the look axis

	// --- colour -------------------------------------------------------------
	colorama: 0.012,         // hue rotation per pass
	saturate: 1.30,
	chromaSplit: 0.0016,     // per-channel offset in the feedback tap
	pixelate: 0.0,           // 0 = off, else cells across the frame
	posterize: 0.0,          // 0 = off, else value levels
	thresh: 0.0,             // keep only what is brighter than this
	threshTol: 0.18,
	invert: 0.0,
	shiftR: 0.0,             // per-channel value offset, hydra's shift()
	shiftG: 0.0,
	shiftB: 0.0,
	// Under one, so the loop is contractive on its own and only stays lit where
	// the world keeps feeding it.
	gain: 0.97,

	// --- what the world reads back ------------------------------------------
	worldDisplace: 0.16,     // metres a point moves under a bright after-image
	worldTint: 0.40          // how much the after-image recolours the point

};

const VERT = /* glsl */`
	varying vec2 vUv;
	void main() {
		vUv = uv;
		gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
	}
`;

const FRAG = /* glsl */`
	precision highp float;

	uniform sampler2D uLive;      // this frame, straight from the scene
	uniform sampler2D uPrev;      // src(o0) — the last frame's output
	uniform vec2 uResolution;
	uniform float uTime;

	uniform float uFeedback;
	uniform float uLiveMix;
	uniform float uDecay;
	uniform float uModAmount;
	uniform float uModScale;
	uniform float uModSpeed;
	uniform float uSelfMod;
	uniform float uRotate;
	uniform float uZoom;
	uniform float uColorama;
	uniform float uSaturate;
	uniform float uChroma;
	uniform float uGain;
	uniform float uFieldMix;
	uniform float uModScaleAmt;
	uniform float uModRotAmt;
	uniform float uKaleid;
	uniform vec2 uRepeat;
	uniform float uPixelate;
	uniform float uPosterize;
	uniform float uThresh;
	uniform float uThreshTol;
	uniform float uInvert;
	uniform vec3 uShift;

	varying vec2 vUv;

	// hydra's colorama, which is a hue rotation rather than a palette lookup.
	vec3 hueRotate( vec3 c, float a ) {
		const vec3 k = vec3( 0.57735 );
		float ca = cos( a );
		return c * ca + cross( k, c ) * sin( a ) + k * dot( k, c ) * ( 1.0 - ca );
	}

	float hash21( vec2 p ) {
		p = fract( p * vec2( 233.34, 851.73 ) );
		p += dot( p, p + 23.45 );
		return fract( p.x * p.y );
	}

	// noise(): value noise, two octaves. Cheap and it reads as weather.
	float vnoise( vec2 p ) {
		vec2 i = floor( p ), f = fract( p );
		f = f * f * ( 3.0 - 2.0 * f );
		float a = hash21( i ), b = hash21( i + vec2( 1.0, 0.0 ) );
		float c = hash21( i + vec2( 0.0, 1.0 ) ), d = hash21( i + vec2( 1.0, 1.0 ) );
		return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y ) * 2.0 - 1.0;
	}

	// voronoi(): distance to the nearest of nine jittered cell centres. Gives the
	// field cell walls, which is what makes a warp look like something growing
	// rather than something wobbling.
	float vor( vec2 p, float t ) {
		vec2 i = floor( p ), f = fract( p );
		float best = 8.0;
		for ( int y = - 1; y <= 1; y ++ ) {
			for ( int x = - 1; x <= 1; x ++ ) {
				vec2 g = vec2( float( x ), float( y ) );
				vec2 o = vec2( hash21( i + g ), hash21( i + g + 17.3 ) );
				o = 0.5 + 0.5 * sin( t + 6.2831 * o );
				best = min( best, length( g + o - f ) );
			}
		}
		return best * 2.0 - 1.0;
	}

	// osc() crossed with noise and voronoi. uFieldMix slides between them.
	float field( vec2 p, float t ) {
		float a = sin( p.x * uModScale + t ) * cos( p.y * uModScale * 0.83 - t * 0.7 );
		float b = sin( ( p.x + p.y ) * uModScale * 0.51 + t * 1.31 );
		float osc = a * 0.6 + b * 0.4;
		float n = vnoise( p * uModScale * 0.5 + t * 0.4 );
		float v = vor( p * uModScale * 0.42, t * 0.7 );
		return mix( mix( osc, n, 0.5 ) , v, uFieldMix );
	}

	// kaleid(): fold the plane into n mirrored wedges about the centre. One of
	// the shortest functions in hydra and the one that changes the picture most.
	vec2 kaleid( vec2 p, float sides ) {
		float a = atan( p.y, p.x );
		float r = length( p );
		float seg = 3.14159265 * 2.0 / sides;
		a = mod( a, seg );
		a = abs( a - seg * 0.5 );
		return vec2( cos( a ), sin( a ) ) * r;
	}

	void main() {
		float aspect = uResolution.x / max( uResolution.y, 1.0 );
		vec2 c = vUv - 0.5;
		c.x *= aspect;

		// rotate() and scale(), applied to the *tap* rather than to the output.
		// Rotating where the feedback is read from is what turns a smear into a
		// spiral; rotating the output would just spin the picture.
		// pixelate() first, so everything downstream samples the quantised grid
		// rather than being quantised after the fact.
		if ( uPixelate > 0.5 ) {
			vec2 cells = vec2( uPixelate, uPixelate / aspect );
			c = ( floor( ( c + 0.5 ) * cells ) + 0.5 ) / cells - 0.5;
		}

		// kaleid() and repeat() act on the tap coordinate, before the spiral.
		if ( uKaleid >= 2.0 ) c = kaleid( c, uKaleid );
		if ( uRepeat.x > 0.5 ) c.x = fract( c.x * uRepeat.x + 0.5 ) - 0.5;
		if ( uRepeat.y > 0.5 ) c.y = fract( c.y * uRepeat.y + 0.5 ) - 0.5;

		// modulateRotate / modulateScale: the spiral and the zoom warped by the
		// field instead of applied uniformly. A uniform rotate is a turntable; a
		// modulated one is something turning at different rates in different
		// places, which is the whole difference.
		float mfield = field( c * 0.8, uTime * uModSpeed * 0.6 );
		float rot = uRotate + mfield * uModRotAmt;
		float zoom = uZoom + mfield * uModScaleAmt;

		float s = sin( rot ), co = cos( rot );
		vec2 r = vec2( c.x * co - c.y * s, c.x * s + c.y * co ) / max( 0.2, zoom );

		// modulate(). The field is sampled at the tap, and the feedback's own
		// brightness folds back into the displacement — which is the difference
		// between a warp that animates and one that evolves.
		vec2 base = vec2( r.x / aspect, r.y ) + 0.5;
		vec4 probe = texture2D( uPrev, clamp( base, 0.001, 0.999 ) );
		float lum = dot( probe.rgb, vec3( 0.299, 0.587, 0.114 ) );

		float f = field( r, uTime * uModSpeed );
		vec2 warp = vec2( f, field( r.yx + 3.7, uTime * uModSpeed * 0.86 ) )
			* uModAmount * ( 1.0 + lum * uSelfMod * 6.0 );

		vec2 tap = clamp( base + warp, 0.001, 0.999 );

		// A per-channel offset in the tap, so recirculating light fringes instead
		// of staying grey. §44.9 reserved chroma absolutely; this build is no
		// longer honouring that, and the reason is that the chroma *is* the
		// subject now rather than a signal held back for one event.
		vec3 prev;
		prev.r = texture2D( uPrev, clamp( tap + warp * uChroma * 90.0, 0.001, 0.999 ) ).r;
		prev.g = texture2D( uPrev, tap ).g;
		prev.b = texture2D( uPrev, clamp( tap - warp * uChroma * 90.0, 0.001, 0.999 ) ).b;

		prev = hueRotate( prev, uColorama );
		prev = max( vec3( 0.0 ), prev * uFeedback - uDecay );

		// thresh(): only what is bright enough recirculates. This is how a loop
		// carries tendrils instead of a wash — everything dim is dropped before
		// it can accumulate.
		if ( uThresh > 0.001 ) {
			float pl = dot( prev, vec3( 0.299, 0.587, 0.114 ) );
			prev *= smoothstep( uThresh - uThreshTol, uThresh + uThreshTol, pl );
		}

		if ( uPosterize > 0.5 ) prev = floor( prev * uPosterize ) / uPosterize;
		prev += uShift;
		if ( uInvert > 0.001 ) prev = mix( prev, 1.0 - prev, uInvert );

		vec3 live = texture2D( uLive, vUv ).rgb;

		// Screen rather than add: the loop has to be able to run hot without
		// clipping to white, and a straight add saturates in about four passes.
		vec3 mixed = 1.0 - ( 1.0 - prev ) * ( 1.0 - live * uLiveMix );

		// diff() against the live frame keeps edges from dissolving into the
		// smear — without it, geometry disappears inside its own after-image.
		mixed += abs( mixed - live ) * 0.12;

		float l = dot( mixed, vec3( 0.299, 0.587, 0.114 ) );
		mixed = mix( vec3( l ), mixed, uSaturate ) * uGain;

		gl_FragColor = vec4( mixed, 1.0 );
	}
`;

export class HydraChain {

	constructor( renderer ) {

		this.renderer = renderer;
		this.enabled = true;

		const opts = {
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			format: THREE.RGBAFormat,
			type: THREE.HalfFloatType,
			depthBuffer: false,
			stencilBuffer: false
		};

		// The ping-pong pair. Two, because you cannot sample and write one
		// texture in a pass; hydra's setBufferCount exists for the same reason and
		// goes further, to stop coupled outputs period-doubling into a strobe.
		// One output here, so two is enough.
		this.a = new THREE.WebGLRenderTarget( 8, 8, opts );
		this.b = new THREE.WebGLRenderTarget( 8, 8, opts );

		this.uniforms = {
			uLive: { value: null },
			uPrev: { value: this.b.texture },
			uResolution: { value: new THREE.Vector2( 8, 8 ) },
			uTime: { value: 0 },
			uFeedback: { value: HYDRA.feedback },
			uLiveMix: { value: HYDRA.live },
			uDecay: { value: HYDRA.decay },
			uModAmount: { value: HYDRA.modAmount },
			uModScale: { value: HYDRA.modScale },
			uModSpeed: { value: HYDRA.modSpeed },
			uSelfMod: { value: HYDRA.selfModulate },
			uRotate: { value: HYDRA.rotate },
			uZoom: { value: HYDRA.zoom },
			uColorama: { value: HYDRA.colorama },
			uSaturate: { value: HYDRA.saturate },
			uChroma: { value: HYDRA.chromaSplit },
			uGain: { value: HYDRA.gain },
			uFieldMix: { value: HYDRA.fieldMix },
			uModScaleAmt: { value: HYDRA.modScaleAmount },
			uModRotAmt: { value: HYDRA.modRotateAmount },
			uKaleid: { value: HYDRA.kaleid },
			uRepeat: { value: new THREE.Vector2( HYDRA.repeatX, HYDRA.repeatY ) },
			uPixelate: { value: HYDRA.pixelate },
			uPosterize: { value: HYDRA.posterize },
			uThresh: { value: HYDRA.thresh },
			uThreshTol: { value: HYDRA.threshTol },
			uInvert: { value: HYDRA.invert },
			uShift: { value: new THREE.Vector3() }
		};

		this.material = new THREE.ShaderMaterial( {
			uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
			depthTest: false, depthWrite: false
		} );

		this.scene = new THREE.Scene();
		this.camera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );
		this.quad = new THREE.Mesh( new THREE.PlaneGeometry( 2, 2 ), this.material );
		this.quad.frustumCulled = false;
		this.scene.add( this.quad );

	}

	setSize( w, h ) {

		const iw = Math.max( 2, Math.floor( w ) ), ih = Math.max( 2, Math.floor( h ) );
		this.a.setSize( iw, ih );
		this.b.setSize( iw, ih );
		this.uniforms.uResolution.value.set( iw, ih );

	}

	// The texture the world reads back. Always the buffer written last, so
	// geometry sees the after-image of the frame that has just been composed.
	get texture() {

		return this.b.texture;

	}

	sync() {

		const u = this.uniforms;
		u.uFeedback.value = HYDRA.feedback;
		u.uLiveMix.value = HYDRA.live;
		u.uDecay.value = HYDRA.decay;
		u.uModAmount.value = HYDRA.modAmount;
		u.uModScale.value = HYDRA.modScale;
		u.uModSpeed.value = HYDRA.modSpeed;
		u.uSelfMod.value = HYDRA.selfModulate;
		u.uRotate.value = HYDRA.rotate;
		u.uZoom.value = HYDRA.zoom;
		u.uColorama.value = HYDRA.colorama;
		u.uSaturate.value = HYDRA.saturate;
		u.uChroma.value = HYDRA.chromaSplit;
		u.uGain.value = HYDRA.gain;
		u.uFieldMix.value = HYDRA.fieldMix;
		u.uModScaleAmt.value = HYDRA.modScaleAmount;
		u.uModRotAmt.value = HYDRA.modRotateAmount;
		u.uKaleid.value = HYDRA.kaleid;
		u.uRepeat.value.set( HYDRA.repeatX, HYDRA.repeatY );
		u.uPixelate.value = HYDRA.pixelate;
		u.uPosterize.value = HYDRA.posterize;
		u.uThresh.value = HYDRA.thresh;
		u.uThreshTol.value = HYDRA.threshTol;
		u.uInvert.value = HYDRA.invert;
		u.uShift.value.set( HYDRA.shiftR, HYDRA.shiftG, HYDRA.shiftB );

	}

	// `live` is this frame's scene. Returns the texture to show.
	render( live, elapsed ) {

		if ( ! HYDRA.enabled ) return live;

		this.sync();
		this.uniforms.uLive.value = live;
		this.uniforms.uPrev.value = this.b.texture;
		this.uniforms.uTime.value = elapsed;

		const prevTarget = this.renderer.getRenderTarget();
		this.renderer.setRenderTarget( this.a );
		this.renderer.render( this.scene, this.camera );
		this.renderer.setRenderTarget( prevTarget );

		// Swap. `b` is now the frame just written, which is what both the
		// compositor and the world read.
		const t = this.a; this.a = this.b; this.b = t;
		return this.b.texture;

	}

	clear() {

		const prevTarget = this.renderer.getRenderTarget();
		for ( const rt of [ this.a, this.b ] ) {

			this.renderer.setRenderTarget( rt );
			this.renderer.clear( true, false, false );

		}
		this.renderer.setRenderTarget( prevTarget );

	}

}

// What geometry needs in order to read the loop back. Shared by scan.js and
// anything else that wants to be warped by its own after-image: sample the
// feedback at this vertex's *previous-frame* screen position, because the
// current one does not exist yet.
export const HYDRA_READ_GLSL = /* glsl */`
	uniform sampler2D uFeed;
	uniform mat4 uPrevViewProj;
	uniform float uFeedDisplace;
	uniform float uFeedTint;
	uniform float uFeedOn;

	// Returns the after-image at this world position, or black if it was off
	// screen last frame — which is correct, an unseen thing has no after-image.
	vec3 feedAt( vec3 wp ) {
		if ( uFeedOn < 0.5 ) return vec3( 0.0 );
		vec4 c = uPrevViewProj * vec4( wp, 1.0 );
		if ( c.w <= 0.0 ) return vec3( 0.0 );
		vec2 uv = c.xy / c.w * 0.5 + 0.5;
		if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) return vec3( 0.0 );
		return texture2D( uFeed, uv ).rgb;
	}
`;
