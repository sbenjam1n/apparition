// Reactive light rig.
//
// Both reference images are lit the same way: a hard linear cove strip raking a
// surface, near-black everything else, one saturated hue, and enough haze that
// the falloff is visible in the air rather than only on the wall. So the rig's
// primitive is not a point light, it is a *line* — a segment with a colour and a
// wattage. Practicals (point lights) are the secondary primitive.
//
// This is a small forward lighting model in one shader rather than three.js
// lights, for three reasons that all matter here:
//
//   1. Cost. A 2019 MacBook will not carry eight shadow-casting area lights, but
//      it will carry an analytic tube-light integral eight times per fragment.
//   2. Reactivity. §35.2 wants a fixture to brighten past its rating and then
//      fail permanently; §10.7 wants thermal bloom on anything held. Both are
//      one uniform write here instead of a light graph edit.
//   3. Consistency. Debris and architecture read the same light, so a chunk
//      tumbling through a cove strip picks up the rake exactly as the wall does.
//
// Tube light irradiance uses the representative-point approximation (Karis,
// "Real Shading in Unreal Engine 4", 2013): shade a point light placed at the
// closest point on the segment. Cheap, and wrong in ways nobody can see.

import * as THREE from 'three';

export const MAX_STRIPS = 8;
export const MAX_PRACTICALS = 6;
export const MAX_SHOCKS = 3;

// The fourth visual register: world-space geometry displacement.
//
// §48.3 establishes three strictly separated registers — the §21 baseline, §44's
// erasure (signal integrity failing: chroma, dropout, wrong colour), and §48's
// low-power perception (resolution failing: sparse sampling, monochrome, point
// cloud). Nothing was claiming *shape*, and that turns out to be useful: a
// shockwave rolling through a wall and a room that has started breathing are both
// expressible here without touching a single one of the other three.
//
// Strictly geometry. No colour, no chroma, no opacity. Chroma in particular is
// reserved absolutely for erasure (§44.9) and a generic "hallucination" uniform
// that also shifted hue would collide with it head-on — the mechanism is worth
// taking, the default look is not.
export const DISPLACE_GLSL = /* glsl */`
	#define MAX_SHOCKS ${MAX_SHOCKS}

	uniform vec3  uShockOrigin[ MAX_SHOCKS ];
	uniform float uShockRadius[ MAX_SHOCKS ];
	uniform float uShockPower[ MAX_SHOCKS ];
	uniform float uShockThickness;
	uniform float uWarpAmount;
	uniform float uWarpScale;
	uniform float uTime;

	vec3 displace( vec3 wp ) {

		vec3 d = vec3( 0.0 );

		for ( int i = 0; i < MAX_SHOCKS; i ++ ) {

			if ( uShockPower[ i ] <= 0.0 ) continue;

			vec3 v = wp - uShockOrigin[ i ];
			float dist = length( v );
			float phase = ( dist - uShockRadius[ i ] ) / uShockThickness;
			if ( phase < - 1.0 || phase > 1.0 ) continue;

			// Push then pull, tapered at both ends — a wave passing through,
			// not a bubble expanding.
			float env = cos( phase * 1.5707963 );
			float push = sin( phase * 3.14159265 ) * env * env;
			d += normalize( v + vec3( 1e-5 ) ) * push * uShockPower[ i ];

		}

		if ( uWarpAmount > 0.0 ) {

			d.x += sin( wp.y * uWarpScale + uTime * 1.7 ) * uWarpAmount;
			d.y += cos( wp.x * uWarpScale + uTime * 1.3 ) * uWarpAmount;
			d.z += sin( ( wp.x + wp.y ) * uWarpScale + uTime * 1.1 ) * uWarpAmount;

		}

		return d;

	}
`;

export const LIGHT_GLSL = /* glsl */`
	#define MAX_STRIPS ${MAX_STRIPS}
	#define MAX_PRACTICALS ${MAX_PRACTICALS}

	uniform vec3  uStripA[ MAX_STRIPS ];
	uniform vec3  uStripB[ MAX_STRIPS ];
	uniform vec3  uStripColor[ MAX_STRIPS ];   // rgb premultiplied by intensity
	uniform float uStripRange[ MAX_STRIPS ];
	uniform int   uStripCount;

	uniform vec3  uPracticalPos[ MAX_PRACTICALS ];
	uniform vec3  uPracticalColor[ MAX_PRACTICALS ];
	uniform float uPracticalRange[ MAX_PRACTICALS ];
	uniform int   uPracticalCount;

	uniform vec3  uAmbient;
	uniform vec3  uFogColor;
	uniform float uFogDensity;
	uniform float uFogHeightFalloff;
	uniform float uFogFloor;
	uniform int   uVolumetricSteps;
	uniform float uVolumetricGain;

	uniform float uWaterLevel;
	uniform vec3  uCausticColor;
	uniform float uCausticStrength;
	uniform float uCausticScale;
	uniform float uCausticFalloff;
	uniform vec4  uPoolBounds;      // xz min, xz max
	uniform float uWrap;
	uniform float uTime;

	// Closest point on segment ab to p.
	vec3 closestOnSegment( vec3 p, vec3 a, vec3 b ) {
		vec3 ab = b - a;
		float len2 = max( dot( ab, ab ), 1e-6 );
		float t = clamp( dot( p - a, ab ) / len2, 0.0, 1.0 );
		return a + ab * t;
	}

	// Smooth windowed inverse-square. The window keeps a strip from lighting the
	// whole room, which is what actually sells "this fixture is only this long".
	float falloff( float dist, float range ) {
		float d2 = dist * dist;
		float f = clamp( 1.0 - d2 * d2 / ( range * range * range * range ), 0.0, 1.0 );
		return f * f / ( d2 + 1.0 );
	}

	// Vein-like animated caustics. Iterative domain warp — the standard trick,
	// four folds is enough to read as water and cheap enough to keep.
	//
	// The magic numbers are not decorative: this only lands in its useful regime
	// when the sample point sits far from the origin, because the inner term is
	// p/(sin(...)/inten). Fed small world coordinates it saturates to flat white,
	// which is exactly what a naive port does. mod-to-TAU then offset by -250
	// reproduces the original's domain and tiles cleanly in world space.
	float caustic( vec2 wp, float t ) {
		const float TAU = 6.28318530718;
		vec2 p = mod( wp * TAU, TAU ) - 250.0;
		vec2 i = p;
		float c = 1.0;
		const float inten = 0.005;

		for ( int n = 0; n < 4; n ++ ) {
			float tt = t * ( 1.0 - ( 3.5 / float( n + 1 ) ) );
			i = p + vec2( cos( tt - i.x ) + sin( tt + i.y ), sin( tt - i.y ) + cos( tt + i.x ) );
			c += 1.0 / length( vec2( p.x / ( sin( i.x + tt ) / inten ), p.y / ( cos( i.y + tt ) / inten ) ) );
		}

		c /= 4.0;
		c = 1.17 - pow( c, 1.4 );
		return clamp( pow( abs( c ), 8.0 ), 0.0, 2.0 );
	}

	// Grout lines. Triplanar-lite: shade against the two axes the normal is not
	// dominated by, so a tile grid wraps the room with no UV authoring.
	//
	// Guarded because fwidth() is fragment-only, and scan.js lights per *vertex*
	// — including this chunk in a vertex shader fails to link, and the failure
	// surfaces as a wall of INVALID_OPERATION rather than as a compile error you
	// can read. Any stage that does not need grout defines LIGHT_NO_DERIVATIVES.
	#ifndef LIGHT_NO_DERIVATIVES
	float tileGrout( vec3 wp, vec3 n, float scale, float lineWidth ) {
		vec3 an = abs( n );
		vec2 uv = an.y > an.x && an.y > an.z ? wp.xz : ( an.x > an.z ? wp.zy : wp.xy );
		vec2 g = abs( fract( uv * scale - 0.5 ) - 0.5 ) / fwidth( uv * scale );
		float line = min( g.x, g.y );
		return 1.0 - clamp( line / max( lineWidth, 0.25 ), 0.0, 1.0 );
	}
	#endif

	struct Surface {
		vec3 pos;
		vec3 normal;
		vec3 albedo;
		float gloss;      // 0 = matte, 1 = wet
		float specular;
	};

	vec3 shadeLight( Surface s, vec3 V, vec3 L, float dist, float range, vec3 color ) {
		float atten = falloff( dist, range );
		if ( atten <= 0.0 ) return vec3( 0.0 );

		float ndl = dot( s.normal, L );
		// A touch of wrap so grazing cove light does not terminate on a hard line;
		// real strips bounce off the surface they are mounted against. Kept small
		// — past about 0.1 it stops reading as bounce and starts reading as a
		// missing shadow, and the whole room goes flat.
		float diffuse = max( ( ndl + uWrap ) / ( 1.0 + uWrap ), 0.0 );

		vec3 H = normalize( L + V );
		float ndh = max( dot( s.normal, H ), 0.0 );
		float power = mix( 8.0, 512.0, s.gloss );
		float spec = pow( ndh, power ) * s.specular * ( s.gloss * 0.9 + 0.1 );

		return color * atten * ( s.albedo * diffuse + vec3( spec ) );
	}

	vec3 directLighting( Surface s, vec3 viewPos ) {
		vec3 V = normalize( viewPos - s.pos );
		vec3 acc = s.albedo * uAmbient;

		for ( int i = 0; i < MAX_STRIPS; i ++ ) {
			if ( i >= uStripCount ) break;
			vec3 rep = closestOnSegment( s.pos, uStripA[ i ], uStripB[ i ] );
			vec3 d = rep - s.pos;
			float dist = length( d );
			if ( dist < 1e-4 ) continue;
			acc += shadeLight( s, V, d / dist, dist, uStripRange[ i ], uStripColor[ i ] );
		}

		for ( int i = 0; i < MAX_PRACTICALS; i ++ ) {
			if ( i >= uPracticalCount ) break;
			vec3 d = uPracticalPos[ i ] - s.pos;
			float dist = length( d );
			if ( dist < 1e-4 ) continue;
			acc += shadeLight( s, V, d / dist, dist, uPracticalRange[ i ], uPracticalColor[ i ] );
		}

		return acc;
	}

	// Caustics are applied as emitted light on surfaces near or below the water
	// line, plus a weaker wash climbing the walls — the pool in the reference is
	// the brightest thing in frame and it lights everything around it.
	vec3 causticLight( Surface s ) {
		if ( uCausticStrength <= 0.0 ) return vec3( 0.0 );

		// Vertical falloff, and a horizontal one from the pool's own footprint.
		// Without the second one every surface in the room picks up caustics and
		// the entire frame goes mint — the pool has to be a *source*, not a tint.
		float height = s.pos.y - uWaterLevel;
		float nearWater = exp( - max( height, 0.0 ) * uCausticFalloff );
		if ( nearWater < 0.004 ) return vec3( 0.0 );

		vec2 d = max( uPoolBounds.xy - s.pos.xz, s.pos.xz - uPoolBounds.zw );
		float outside = length( max( d, vec2( 0.0 ) ) );
		float reach = exp( - outside * 0.62 );
		if ( reach < 0.004 ) return vec3( 0.0 );

		// Two different things, and conflating them makes the whole floor look
		// like water: inside the pool footprint you see the projected veins;
		// outside it you only see bounce, which is diffuse and has no pattern.
		float inside = 1.0 - smoothstep( 0.0, 0.7, outside );
		float veins = caustic( s.pos.xz * uCausticScale, uTime * 0.35 );
		float lit = mix( 0.4 * reach, veins, inside );

		// Below the surface it is projected straight down; above, it is bounce,
		// so it should fade with how much of the sky-ward hemisphere sees water.
		float facing = mix( 0.2, 1.0, clamp( s.normal.y * 0.5 + 0.5, 0.0, 1.0 ) );
		return uCausticColor * lit * uCausticStrength * nearWater * reach * facing;
	}

	// In-scattering along the view ray. Three taps is enough to get the shafts in
	// the first reference without a real volumetric pass; the governor can set
	// uVolumetricSteps to 0 on a weak GPU and only the haze remains.
	vec3 volumetric( vec3 camPos, vec3 worldPos ) {
		if ( uVolumetricSteps <= 0 || uVolumetricGain <= 0.0 ) return vec3( 0.0 );

		vec3 acc = vec3( 0.0 );
		float steps = float( uVolumetricSteps );

		for ( int k = 0; k < 4; k ++ ) {
			if ( k >= uVolumetricSteps ) break;
			float t = ( float( k ) + 0.5 ) / steps;
			vec3 sp = mix( camPos, worldPos, t );
			float hz = exp( - max( sp.y - uFogFloor, 0.0 ) * uFogHeightFalloff );

			for ( int i = 0; i < MAX_STRIPS; i ++ ) {
				if ( i >= uStripCount ) break;
				vec3 rep = closestOnSegment( sp, uStripA[ i ], uStripB[ i ] );
				float d = length( rep - sp );
				acc += uStripColor[ i ] * falloff( d, uStripRange[ i ] ) * hz;
			}
		}

		return acc * ( uVolumetricGain / steps );
	}

	vec3 applyFog( vec3 color, vec3 camPos, vec3 worldPos ) {
		float dist = length( worldPos - camPos );
		float h = exp( - max( worldPos.y - uFogFloor, 0.0 ) * uFogHeightFalloff );
		float amount = 1.0 - exp( - uFogDensity * dist * h );
		return mix( color, uFogColor, clamp( amount, 0.0, 1.0 ) );
	}
`;

export class LightRig {

	constructor() {

		const stripA = [], stripB = [], stripColor = [], stripRange = [];

		for ( let i = 0; i < MAX_STRIPS; i ++ ) {

			stripA.push( new THREE.Vector3() );
			stripB.push( new THREE.Vector3() );
			stripColor.push( new THREE.Vector3() );
			stripRange.push( 1 );

		}

		const pPos = [], pColor = [], pRange = [];

		for ( let i = 0; i < MAX_PRACTICALS; i ++ ) {

			pPos.push( new THREE.Vector3() );
			pColor.push( new THREE.Vector3() );
			pRange.push( 1 );

		}

		const shockOrigin = [], shockRadius = [], shockPower = [];

		for ( let i = 0; i < MAX_SHOCKS; i ++ ) {

			shockOrigin.push( new THREE.Vector3() );
			shockRadius.push( 0 );
			shockPower.push( 0 );

		}

		this.uniforms = {
			uStripA: { value: stripA },
			uStripB: { value: stripB },
			uStripColor: { value: stripColor },
			uStripRange: { value: stripRange },
			uStripCount: { value: 0 },

			uPracticalPos: { value: pPos },
			uPracticalColor: { value: pColor },
			uPracticalRange: { value: pRange },
			uPracticalCount: { value: 0 },

			// Calibrated against the references rather than picked: the room sits
			// near black, the cove line and the pool are the only things at or
			// above 1.0, and everything else is what those two spill.
			uAmbient: { value: new THREE.Color( 0x03060a ) },
			uFogColor: { value: new THREE.Color( 0x070f15 ) },
			uFogDensity: { value: 0.05 },
			uFogHeightFalloff: { value: 0.045 },
			uFogFloor: { value: 0 },
			uVolumetricSteps: { value: 3 },
			uVolumetricGain: { value: 0.14 },
			uWrap: { value: 0.06 },

			uWaterLevel: { value: 0 },
			uCausticColor: { value: new THREE.Color( 0x2affc4 ) },
			uCausticStrength: { value: 0.5 },
			uCausticScale: { value: 0.16 },
			uCausticFalloff: { value: 1.5 },
			uPoolBounds: { value: new THREE.Vector4( - 1, - 1, 1, 1 ) },
			uTime: { value: 0 },

			uCamPos: { value: new THREE.Vector3() },

			// Fourth register — shape only.
			uShockOrigin: { value: shockOrigin },
			uShockRadius: { value: shockRadius },
			uShockPower: { value: shockPower },
			uShockThickness: { value: 1.6 },
			uWarpAmount: { value: 0 },
			uWarpScale: { value: 0.55 }
		};

		this.shocks = [];

		for ( let i = 0; i < MAX_SHOCKS; i ++ ) {

			this.shocks.push( { power: 0, peak: 0, radius: 0, speed: 9, range: 22 } );

		}

		this._shockCursor = 0;

		// Authored fixtures. Each one owns its rating so overvolting has a real
		// threshold to cross rather than an arbitrary number (§35.2).
		this.strips = [];
		this.practicals = [];

	}

	addStrip( ax, ay, az, bx, by, bz, color, intensity, range ) {

		const s = {
			index: this.strips.length,
			a: new THREE.Vector3( ax, ay, az ),
			b: new THREE.Vector3( bx, by, bz ),
			color: new THREE.Color( color ),
			intensity,
			rated: intensity,
			range,
			// Fixture state: 1 = lit, 0 = dead. Overvolting drives `charge` up;
			// past the rating it burns and never comes back (§35.3).
			charge: 0,
			dead: false,
			flicker: 0,
			mesh: null
		};

		this.strips.push( s );
		this.uniforms.uStripCount.value = Math.min( this.strips.length, MAX_STRIPS );
		return s;

	}

	addPractical( x, y, z, color, intensity, range ) {

		const p = {
			index: this.practicals.length,
			pos: new THREE.Vector3( x, y, z ),
			color: new THREE.Color( color ),
			intensity,
			rated: intensity,
			range,
			charge: 0,
			dead: false,
			flicker: 0,
			mesh: null
		};

		this.practicals.push( p );
		this.uniforms.uPracticalCount.value = Math.min( this.practicals.length, MAX_PRACTICALS );
		return p;

	}

	// Pull power out of a fixture. Returns the watts actually harvested. The
	// fixture brightens as it goes — the tell that guides you to a source is the
	// same tell that betrays you (§35.2).
	overvolt( fixture, dt, rate = 1.6 ) {

		if ( fixture.dead ) return 0;

		fixture.charge += dt * rate;
		const over = 1 + fixture.charge * 1.4;
		fixture.intensity = fixture.rated * over;

		if ( fixture.charge > 1.0 ) {

			fixture.dead = true;
			fixture.intensity = 0;
			fixture.charge = 0;
			if ( fixture.mesh ) fixture.mesh.visible = false;
			return - 1;   // caller treats -1 as "it burst"

		}

		return fixture.rated * dt * rate;

	}

	// Kick off a displacement wave. Slots are recycled round-robin; a fourth
	// concurrent shockwave overwrites the oldest, which is correct — by then you
	// cannot read them apart anyway.
	shockwave( x, y, z, power = 0.14, speed = 9, range = 22 ) {

		const i = this._shockCursor;
		this._shockCursor = ( this._shockCursor + 1 ) % MAX_SHOCKS;

		const s = this.shocks[ i ];
		s.power = power; s.peak = power; s.radius = 0; s.speed = speed; s.range = range;
		this.uniforms.uShockOrigin.value[ i ].set( x, y, z );
		this.uniforms.uShockRadius.value[ i ] = 0;
		this.uniforms.uShockPower.value[ i ] = power;

	}

	pulse( fixture, amount = 0.4, decay = 6 ) {

		if ( fixture.dead ) return;
		fixture.flicker = Math.max( fixture.flicker, amount );
		fixture._decay = decay;

	}

	update( dt, camPos ) {

		this.uniforms.uCamPos.value.copy( camPos );

		const u = this.uniforms;

		for ( let i = 0; i < MAX_SHOCKS; i ++ ) {

			const s = this.shocks[ i ];
			if ( s.power <= 0 ) continue;

			s.radius += s.speed * dt;
			// Amplitude falls with the front's own expansion, so a wave thins out
			// rather than being switched off on a timer.
			s.power = s.peak * Math.max( 0, 1 - s.radius / s.range );

			u.uShockRadius.value[ i ] = s.radius;
			u.uShockPower.value[ i ] = s.power;

			if ( s.radius > s.range ) { s.power = 0; u.uShockPower.value[ i ] = 0; }

		}

		for ( let i = 0; i < this.strips.length && i < MAX_STRIPS; i ++ ) {

			const s = this.strips[ i ];

			if ( s.flicker > 0 ) s.flicker = Math.max( 0, s.flicker - dt * ( s._decay || 6 ) );

			const level = s.dead ? 0 : s.intensity * ( 1 + s.flicker * ( Math.random() - 0.5 ) * 2 );

			u.uStripA.value[ i ].copy( s.a );
			u.uStripB.value[ i ].copy( s.b );
			u.uStripColor.value[ i ].set( s.color.r * level, s.color.g * level, s.color.b * level );
			u.uStripRange.value[ i ] = s.range;

			if ( s.mesh ) {

				s.mesh.material.color.copy( s.color ).multiplyScalar( Math.min( level, 6 ) );
				s.mesh.visible = ! s.dead;

			}

		}

		for ( let i = 0; i < this.practicals.length && i < MAX_PRACTICALS; i ++ ) {

			const p = this.practicals[ i ];

			if ( p.flicker > 0 ) p.flicker = Math.max( 0, p.flicker - dt * ( p._decay || 6 ) );

			const level = p.dead ? 0 : p.intensity * ( 1 + p.flicker * ( Math.random() - 0.5 ) * 2 );

			u.uPracticalPos.value[ i ].copy( p.pos );
			u.uPracticalColor.value[ i ].set( p.color.r * level, p.color.g * level, p.color.b * level );
			u.uPracticalRange.value[ i ] = p.range;

			if ( p.mesh ) {

				p.mesh.position.copy( p.pos );
				p.mesh.material.color.copy( p.color ).multiplyScalar( Math.min( level, 6 ) );
				p.mesh.visible = ! p.dead;

			}

		}

	}

	// Total lit fixtures — the level's remaining light budget. §35.3: the thing
	// you spend is the thing you see by.
	remaining() {

		let live = 0, total = 0;

		for ( const s of this.strips ) { total ++; if ( ! s.dead ) live ++; }
		for ( const p of this.practicals ) { total ++; if ( ! p.dead ) live ++; }

		return total === 0 ? 1 : live / total;

	}

}
