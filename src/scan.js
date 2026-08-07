// The scan.
//
// Answering a specific question: does an abstracted point-cloud world — House of
// Cards, a LIDAR return, the pen's flying particles — buy *more destructible*
// environments? The honest answer is yes, but not for the reason it looks like,
// and the distinction matters enough to write down before any of this is tuned.
//
// It does NOT raise the physics budget. If "destructible" means more
// independently colliding chunks, points change nothing: five thousand pieces
// that collide need five thousand bodies whether they are drawn as boxes or as
// dots, and the solver's contact graph is the binding constraint either way.
//
// What it removes is the *geometry* budget and the *authoring* budget, and those
// are what actually cap destructibility in practice:
//
//   * A point has no interior. Carving a hole in a mesh means CSG, cap
//     generation, and unshaded backfaces; carving a hole in a point set means
//     not drawing some points. Arbitrary damage at arbitrary resolution costs
//     one float per point and no geometry work at all.
//   * Destruction stops being authored. destruct.js needs a hand-built chunk
//     grid and a tuned weld lattice per panel, which is why this build has three
//     destructible surfaces and not three hundred. Here every surface erodes by
//     default, because erosion is subtraction from a set.
//   * Damage becomes a field rather than a state machine. INTACT/BREACHED/OPEN
//     exists because a mesh has to be told which discrete configuration it is
//     in. A density field is continuous and needs no enumeration.
//
// Two things it does not fix, stated up front so they are not discovered later:
// the player still has to collide with *something*, so a solid representation
// survives underneath and the points must be derived from it rather than
// authored alongside it — which is why every point here is generated from the
// solver's own colliders and cannot disagree with them. And legibility is a real
// risk: House of Cards is beautiful and you cannot tell where anything is, which
// is a bad trade in a game about flying through gaps at speed.
//
// It also makes three things the index already wants native rather than bolted
// on. §44's erasure and §48's low-power register are both "the world fails to
// resolve", which in a scan is literally sample density falling. And §38's
// accretion enemies are described as made of dust — in a point world an NPC is
// the same primitive as a wall at a different density, which is a much stronger
// position than a separate character pipeline.

import * as THREE from 'three';
import { LIGHT_GLSL } from './lighting.js';

export const SCAN = {

	// --- sampling -----------------------------------------------------------
	// Anisotropic on purpose. Even spacing reads as noise; rows read as a scan,
	// and the visible structure of the *sampling* is most of why the reference
	// images look like data rather than like particles.
	rowGap: 0.19,            // metres between scan rows
	dotGap: 0.075,           // metres between samples along a row
	jitter: 0.35,            // fraction of spacing; kills the moire, keeps the rows
	budget: 220000,          // hard cap; spacing is relaxed until the set fits

	// --- look ---------------------------------------------------------------
	pointSize: 2.4,          // pixels at one metre
	sizeFalloff: 0.55,       // how fast size drops with distance, 0..1
	minPixels: 1.0,
	maxPixels: 5.0,
	// The LIDAR ramp: cold and dense at the floor, hot at the ceiling. It is a
	// convention rather than a lighting model and that is exactly why it works —
	// height reads instantly and unambiguously, which is what a 6DOF room most
	// needs and what a point cloud is otherwise worst at.
	rampLow: new THREE.Color( 0x1030ff ),
	rampMid: new THREE.Color( 0x18d8b0 ),
	rampHigh: new THREE.Color( 0xffc23c ),
	rampFloor: - 1.6,
	rampCeil: 9.0,
	lit: 0.30,               // blend toward the room's actual lighting rig
	glow: 1.35,              // the ramp is a return, not a reflectance; it emits
	// A scan is a measurement coming back, not light crossing the room, so full
	// atmospheric fog on it is wrong twice over: it is the wrong physics and it
	// puts the far wall under the noise floor at ten metres, which is exactly the
	// distance a 6DOF player most needs to read.
	fogMix: 0.35,
	sparkle: 0.35,           // per-point twinkle; the scan is never quite still

	// --- damage -------------------------------------------------------------
	loosen: 0.55,            // metres a point drifts before it goes
	dropAt: 1.0,             // damage at which a point stops drawing
	settle: 0.0              // damage decay per second; 0 = permanent (§7.5)

};

const _c = new THREE.Color();

export class ScanField {

	constructor( scene, rig, room ) {

		this.room = room;
		this.count = 0;
		this.eroded = 0;

		this.px = null; this.py = null; this.pz = null;
		this.nx = null; this.ny = null; this.nz = null;
		this.damage = null;
		this.seed = null;

		this.uniforms = Object.assign( {}, rig.uniforms, {
			uCamPos: rig.uniforms.uCamPos,
			uPointSize: { value: SCAN.pointSize },
			uSizeFalloff: { value: SCAN.sizeFalloff },
			uMinPixels: { value: SCAN.minPixels },
			uMaxPixels: { value: SCAN.maxPixels },
			uRampLow: { value: SCAN.rampLow.clone() },
			uRampMid: { value: SCAN.rampMid.clone() },
			uRampHigh: { value: SCAN.rampHigh.clone() },
			uRampFloor: { value: SCAN.rampFloor },
			uRampCeil: { value: SCAN.rampCeil },
			uLit: { value: SCAN.lit },
			uSparkle: { value: SCAN.sparkle },
			uGlow: { value: SCAN.glow },
			uFogMix: { value: SCAN.fogMix },
			uLoosen: { value: SCAN.loosen },
			uPixelRatio: { value: 1 }
		} );

		this.material = new THREE.ShaderMaterial( {
			uniforms: this.uniforms,
			transparent: true,
			depthWrite: true,
			blending: THREE.NormalBlending,
			vertexShader: /* glsl */`
				attribute vec3 aNormal;
				attribute float aDamage;
				attribute float aSeed;

				uniform float uPointSize;
				uniform float uSizeFalloff;
				uniform float uMinPixels;
				uniform float uMaxPixels;
				uniform float uLoosen;
				uniform float uPixelRatio;
				uniform float uTime;
				uniform vec3 uCamPos;

				varying vec3 vWorld;
				varying vec3 vNrm;
				varying float vDamage;
				varying float vSeed;

				void main() {
					vDamage = aDamage;
					vSeed = aSeed;
					vNrm = aNormal;

					vec3 p = position;

					// Damaged points drift before they vanish, so a surface visibly
					// loosens rather than switching off. This is the whole reason a
					// scan can carry destruction that a mesh cannot: there is no
					// topology to keep valid, so a point is free to leave.
					if ( aDamage > 0.0 ) {
						float d = aDamage;
						float t = uTime * ( 0.6 + aSeed * 1.7 );
						p += aNormal * d * uLoosen * 0.4;
						p.x += sin( t + aSeed * 41.0 ) * d * uLoosen;
						p.y += cos( t * 1.31 + aSeed * 17.0 ) * d * uLoosen * 0.7 - d * d * uLoosen * 1.6;
						p.z += sin( t * 0.87 + aSeed * 63.0 ) * d * uLoosen;
					}

					vWorld = p;

					vec4 mv = viewMatrix * vec4( p, 1.0 );
					float dist = max( - mv.z, 0.05 );

					// Between constant-world-size (which vanishes at range) and
					// constant-pixel-size (which turns distance into a wall of dots).
					float px = uPointSize * uPixelRatio / pow( dist, uSizeFalloff );
					gl_PointSize = clamp( px, uMinPixels * uPixelRatio, uMaxPixels * uPixelRatio );
					gl_Position = projectionMatrix * mv;
				}
			`,
			fragmentShader: LIGHT_GLSL + /* glsl */`
				uniform vec3 uRampLow;
				uniform vec3 uRampMid;
				uniform vec3 uRampHigh;
				uniform float uRampFloor;
				uniform float uRampCeil;
				uniform float uLit;
				uniform float uSparkle;
				uniform float uGlow;
				uniform float uFogMix;
				uniform vec3 uCamPos;

				varying vec3 vWorld;
				varying vec3 vNrm;
				varying float vDamage;
				varying float vSeed;

				void main() {
					// Round points. Square ones read as pixels and give the whole
					// thing away as a rasteriser rather than a return.
					vec2 q = gl_PointCoord * 2.0 - 1.0;
					float r2 = dot( q, q );
					if ( r2 > 1.0 ) discard;

					float h = clamp( ( vWorld.y - uRampFloor ) / max( 0.001, uRampCeil - uRampFloor ), 0.0, 1.0 );
					vec3 ramp = h < 0.5
						? mix( uRampLow, uRampMid, h * 2.0 )
						: mix( uRampMid, uRampHigh, ( h - 0.5 ) * 2.0 );

					// The ramp is the read; the rig is the room. Mixing rather than
					// choosing keeps a scanned wall reacting to a cove strip crossing
					// it, which is what stops the world looking like a diagram.
					Surface s;
					s.pos = vWorld;
					s.normal = normalize( vNrm );
					s.albedo = ramp;
					s.gloss = 0.0;
					s.specular = 0.0;
					vec3 color = mix( ramp * uGlow, directLighting( s, uCamPos ) + causticLight( s ), uLit );

					// Never quite still. A dead-static point cloud reads as geometry;
					// a scan that shimmers reads as something being sensed.
					float tw = sin( uTime * ( 1.4 + vSeed * 3.3 ) + vSeed * 90.0 ) * 0.5 + 0.5;
					color *= 1.0 - uSparkle + uSparkle * tw * 1.6;

					color += volumetric( uCamPos, vWorld ) * uFogMix;
					color = mix( color, applyFog( color, uCamPos, vWorld ), uFogMix );

					// Damaged points burn out rather than fading grey.
					float alpha = ( 1.0 - vDamage * 0.75 ) * smoothstep( 1.0, 0.35, r2 );
					color += vec3( 1.0, 0.42, 0.15 ) * vDamage * 0.8;

					gl_FragColor = vec4( color, alpha );
				}
			`
		} );

		this.geometry = new THREE.BufferGeometry();
		this.points = new THREE.Points( this.geometry, this.material );
		this.points.frustumCulled = false;
		this.points.visible = false;
		scene.add( this.points );

	}

	// Build the cloud from the solver's own colliders.
	//
	// Deriving rather than authoring is the one non-negotiable here. A point set
	// modelled separately from the collision would eventually disagree with it,
	// and in a game about threading gaps at speed a wall that draws in the wrong
	// place is not a visual bug, it is a lie about where you can fly.
	build( solver ) {

		const R = this.room;
		const pts = [];

		// Relax spacing until the set fits the budget, rather than truncating —
		// a truncated cloud is a room with one wall missing.
		let row = SCAN.rowGap, dot = SCAN.dotGap;

		for ( let attempt = 0; attempt < 12; attempt ++ ) {

			pts.length = 0;
			this._samplePlanes( solver, pts, row, dot );
			this._sampleBoxes( solver, pts, row, dot );
			if ( pts.length / 7 <= SCAN.budget ) break;
			row *= 1.18; dot *= 1.18;

		}

		const n = pts.length / 7;
		this.count = n;
		this.spacing = { row, dot };

		const pos = new Float32Array( n * 3 );
		const nrm = new Float32Array( n * 3 );
		this.damage = new Float32Array( n );
		this.seed = new Float32Array( n );
		this.px = new Float32Array( n );
		this.py = new Float32Array( n );
		this.pz = new Float32Array( n );

		for ( let i = 0; i < n; i ++ ) {

			const b = i * 7;
			pos[ i * 3 ] = this.px[ i ] = pts[ b ];
			pos[ i * 3 + 1 ] = this.py[ i ] = pts[ b + 1 ];
			pos[ i * 3 + 2 ] = this.pz[ i ] = pts[ b + 2 ];
			nrm[ i * 3 ] = pts[ b + 3 ];
			nrm[ i * 3 + 1 ] = pts[ b + 4 ];
			nrm[ i * 3 + 2 ] = pts[ b + 5 ];
			this.seed[ i ] = pts[ b + 6 ];

		}

		this.geometry.setAttribute( 'position', new THREE.BufferAttribute( pos, 3 ) );
		this.geometry.setAttribute( 'aNormal', new THREE.BufferAttribute( nrm, 3 ) );
		this.damageAttr = new THREE.BufferAttribute( this.damage, 1 );
		this.damageAttr.setUsage( THREE.DynamicDrawUsage );
		this.geometry.setAttribute( 'aDamage', this.damageAttr );
		this.geometry.setAttribute( 'aSeed', new THREE.BufferAttribute( this.seed, 1 ) );
		this.geometry.setDrawRange( 0, n );

		this._buildHash();
		return n;

	}

	_push( out, x, y, z, nx, ny, nz ) {

		out.push( x, y, z, nx, ny, nz, Math.random() );

	}

	// Room bounds, so an infinite half-space becomes a finite wall.
	_samplePlanes( solver, out, row, dot ) {

		const R = this.room;
		const lo = { x: - R.halfW, y: R.pool.bottom, z: - R.halfD };
		const hi = { x: R.halfW, y: R.height, z: R.halfD };

		for ( const pl of solver.planes ) {

			// Which axis the plane faces decides which two axes it spans.
			const ax = Math.abs( pl.nx ) > 0.5 ? 0 : Math.abs( pl.ny ) > 0.5 ? 1 : 2;
			const u = ax === 0 ? 1 : 0;          // rows run along here
			const v = ax === 2 ? 1 : 2;

			// A point on the plane: n·p = d, so p = n*d.
			const base = [ pl.nx * pl.d, pl.ny * pl.d, pl.nz * pl.d ];
			const loA = [ lo.x, lo.y, lo.z ], hiA = [ hi.x, hi.y, hi.z ];

			for ( let a = loA[ u ]; a <= hiA[ u ]; a += row ) {

				for ( let b = loA[ v ]; b <= hiA[ v ]; b += dot ) {

					const p = [ base[ 0 ], base[ 1 ], base[ 2 ] ];
					p[ u ] = a + ( Math.random() - 0.5 ) * row * SCAN.jitter;
					p[ v ] = b + ( Math.random() - 0.5 ) * dot * SCAN.jitter;
					this._push( out, p[ 0 ], p[ 1 ], p[ 2 ], pl.nx, pl.ny, pl.nz );

				}

			}

		}

		// The floor is not a solver plane — bodies rest on the pool box — so it is
		// sampled explicitly rather than being left as a hole in the world.
		for ( let x = - R.halfW; x <= R.halfW; x += row ) {

			for ( let z = - R.halfD; z <= R.halfD; z += dot ) {

				const inPool = x > R.pool.x0 && x < R.pool.x1 && z > R.pool.z0 && z < R.pool.z1;
				this._push( out,
					x + ( Math.random() - 0.5 ) * row * SCAN.jitter, inPool ? R.pool.water : 0,
					z + ( Math.random() - 0.5 ) * dot * SCAN.jitter, 0, 1, 0 );

			}

		}

	}

	// Six faces per box. Rows run along the face's longer axis so the scan lines
	// read as horizontal on a wall and as depth on a floor.
	_sampleBoxes( solver, out, row, dot ) {

		for ( const b of solver.boxes ) {

			const h = [ b.hx, b.hy, b.hz ];
			const c = [ b.cx, b.cy, b.cz ];

			for ( let axis = 0; axis < 3; axis ++ ) {

				const u = ( axis + 1 ) % 3, v = ( axis + 2 ) % 3;

				for ( const sign of [ - 1, 1 ] ) {

					for ( let a = - h[ u ]; a <= h[ u ]; a += row ) {

						for ( let d = - h[ v ]; d <= h[ v ]; d += dot ) {

							const p = [ 0, 0, 0 ];
							p[ axis ] = c[ axis ] + sign * h[ axis ];
							p[ u ] = c[ u ] + a + ( Math.random() - 0.5 ) * row * SCAN.jitter;
							p[ v ] = c[ v ] + d + ( Math.random() - 0.5 ) * dot * SCAN.jitter;

							const nrm = [ 0, 0, 0 ];
							nrm[ axis ] = sign;
							this._push( out, p[ 0 ], p[ 1 ], p[ 2 ], nrm[ 0 ], nrm[ 1 ], nrm[ 2 ] );

						}

					}

				}

			}

		}

	}

	// Uniform grid over the room, so carving is a handful of cells rather than a
	// scan of two hundred thousand points. Built once; points never move between
	// cells because a damaged point is on its way out, not relocating.
	_buildHash() {

		const R = this.room;
		this.cell = 1.0;
		this.origin = { x: - R.halfW - 2, y: R.pool.bottom - 2, z: - R.halfD - 2 };
		this.dim = {
			x: Math.ceil( ( R.halfW * 2 + 4 ) / this.cell ),
			y: Math.ceil( ( R.height - R.pool.bottom + 4 ) / this.cell ),
			z: Math.ceil( ( R.halfD * 2 + 4 ) / this.cell )
		};

		const cells = this.dim.x * this.dim.y * this.dim.z;
		const counts = new Int32Array( cells + 1 );
		const idx = new Int32Array( this.count );

		for ( let i = 0; i < this.count; i ++ ) {

			const c = this._cell( this.px[ i ], this.py[ i ], this.pz[ i ] );
			idx[ i ] = c;
			if ( c >= 0 ) counts[ c + 1 ] ++;

		}

		for ( let c = 0; c < cells; c ++ ) counts[ c + 1 ] += counts[ c ];

		const list = new Int32Array( this.count );
		const cursor = counts.slice( 0, cells );

		for ( let i = 0; i < this.count; i ++ ) {

			const c = idx[ i ];
			if ( c >= 0 ) list[ cursor[ c ] ++ ] = i;

		}

		this.hashStart = counts;
		this.hashList = list;

	}

	_cell( x, y, z ) {

		const i = Math.floor( ( x - this.origin.x ) / this.cell );
		const j = Math.floor( ( y - this.origin.y ) / this.cell );
		const k = Math.floor( ( z - this.origin.z ) / this.cell );
		if ( i < 0 || j < 0 || k < 0 || i >= this.dim.x || j >= this.dim.y || k >= this.dim.z ) return - 1;
		return ( k * this.dim.y + j ) * this.dim.x + i;

	}

	// Erode. This is the entire destruction model for a scanned surface, and it
	// is worth appreciating how little there is of it: no chunk grid, no weld
	// lattice, no union-find over survivors, no aperture enumeration, no state
	// machine. Raise a float, and a hole is a place where the floats are high.
	carve( x, y, z, radius, amount ) {

		if ( ! this.hashStart ) return 0;

		const r2 = radius * radius;
		const ci = Math.floor( ( x - this.origin.x ) / this.cell );
		const cj = Math.floor( ( y - this.origin.y ) / this.cell );
		const ck = Math.floor( ( z - this.origin.z ) / this.cell );
		const span = Math.ceil( radius / this.cell );
		let touched = 0;

		for ( let k = ck - span; k <= ck + span; k ++ ) {

			if ( k < 0 || k >= this.dim.z ) continue;

			for ( let j = cj - span; j <= cj + span; j ++ ) {

				if ( j < 0 || j >= this.dim.y ) continue;

				for ( let i = ci - span; i <= ci + span; i ++ ) {

					if ( i < 0 || i >= this.dim.x ) continue;

					const c = ( k * this.dim.y + j ) * this.dim.x + i;
					const s = this.hashStart[ c ], e = this.hashStart[ c + 1 ];

					for ( let n = s; n < e; n ++ ) {

						const p = this.hashList[ n ];
						if ( this.damage[ p ] >= SCAN.dropAt ) continue;

						const dx = this.px[ p ] - x, dy = this.py[ p ] - y, dz = this.pz[ p ] - z;
						const d2 = dx * dx + dy * dy + dz * dz;
						if ( d2 > r2 ) continue;

						// Softer at the rim, so a hole has a frayed edge rather than a
						// stamped one. Free here; on a mesh it would be a remesh.
						const fall = 1 - Math.sqrt( d2 ) / radius;
						const was = this.damage[ p ];
						this.damage[ p ] = Math.min( SCAN.dropAt, was + amount * fall * fall );
						if ( was < SCAN.dropAt && this.damage[ p ] >= SCAN.dropAt ) this.eroded ++;
						touched ++;

					}

				}

			}

		}

		if ( touched ) this._dirty = true;
		return touched;

	}

	// How intact a region is, 0..1. The continuous replacement for §31.3's
	// three-state panel enumeration: an aperture is a place where this is low.
	intact( x, y, z, radius ) {

		if ( ! this.hashStart ) return 1;

		const r2 = radius * radius;
		const ci = Math.floor( ( x - this.origin.x ) / this.cell );
		const cj = Math.floor( ( y - this.origin.y ) / this.cell );
		const ck = Math.floor( ( z - this.origin.z ) / this.cell );
		const span = Math.ceil( radius / this.cell );
		let total = 0, alive = 0;

		for ( let k = ck - span; k <= ck + span; k ++ ) {

			if ( k < 0 || k >= this.dim.z ) continue;

			for ( let j = cj - span; j <= cj + span; j ++ ) {

				if ( j < 0 || j >= this.dim.y ) continue;

				for ( let i = ci - span; i <= ci + span; i ++ ) {

					if ( i < 0 || i >= this.dim.x ) continue;
					const c = ( k * this.dim.y + j ) * this.dim.x + i;

					for ( let n = this.hashStart[ c ]; n < this.hashStart[ c + 1 ]; n ++ ) {

						const p = this.hashList[ n ];
						const dx = this.px[ p ] - x, dy = this.py[ p ] - y, dz = this.pz[ p ] - z;
						if ( dx * dx + dy * dy + dz * dz > r2 ) continue;
						total ++;
						if ( this.damage[ p ] < SCAN.dropAt ) alive ++;

					}

				}

			}

		}

		return total === 0 ? 1 : alive / total;

	}

	restore() {

		this.damage.fill( 0 );
		this.eroded = 0;
		this._dirty = true;

	}

	update( dt ) {

		if ( SCAN.settle > 0 ) {

			for ( let i = 0; i < this.count; i ++ ) {

				if ( this.damage[ i ] > 0 && this.damage[ i ] < SCAN.dropAt ) {

					this.damage[ i ] = Math.max( 0, this.damage[ i ] - SCAN.settle * dt );
					this._dirty = true;

				}

			}

		}

		if ( this._dirty ) { this.damageAttr.needsUpdate = true; this._dirty = false; }

		const u = this.uniforms;
		u.uPointSize.value = SCAN.pointSize;
		u.uSizeFalloff.value = SCAN.sizeFalloff;
		u.uMinPixels.value = SCAN.minPixels;
		u.uMaxPixels.value = SCAN.maxPixels;
		u.uLit.value = SCAN.lit;
		u.uSparkle.value = SCAN.sparkle;
		u.uGlow.value = SCAN.glow;
		u.uFogMix.value = SCAN.fogMix;
		u.uLoosen.value = SCAN.loosen;
		u.uRampFloor.value = SCAN.rampFloor;
		u.uRampCeil.value = SCAN.rampCeil;

	}

}
