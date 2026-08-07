// The scan.
//
// The reference is the House of Cards video (Frost / Koblin, 2008), which was
// shot without a single camera or light. Two systems: Geometric Informatics
// structured light for the close work, and a Velodyne HDL-64E — sixty-four
// lasers on a head spinning at 900rpm — for everything environmental. The
// numbers in SCAN below are that sensor's.
//
// The thing that took a rewrite to understand is that **a point cloud is a
// property of the sensor, not of the world**. The first version of this file
// walked every collider face on a Cartesian grid, which gives a point-ified
// mesh: evenly dense everywhere, no voids, no rings, identical density at one
// metre and at forty. Every one of those is wrong, and none of them can be fixed
// by tuning — they are fixed by actually casting the beams.
//
// It also answers a specific question: does an abstracted point-cloud world buy
// *more destructible* environments? Yes, but not for the reason it looks like,
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

	// --- the sensor ---------------------------------------------------------
	//
	// These are the Velodyne HDL-64E's numbers, because they are the numbers the
	// House of Cards exteriors were shot on: sixty-four lasers on one spinning
	// head, a 26.8-degree vertical fan running from +2 down to -24.8, and a
	// revolution every 1/15th of a second. The horizontal step is the one this
	// build coarsens — the real sensor samples azimuth at 0.08 degrees, which is
	// four and a half thousand columns per turn.
	//
	// The ratio between the two is not a detail, it is the entire look. Vertical
	// spacing is five times the horizontal, so a return lands as a *line* with
	// gaps above and below it rather than as a fog of evenly spread dots. Sample
	// isotropically and you get static; keep the anisotropy and you get a scan.
	// Thirty-two rather than the hardware's sixty-four, and that is a considered
	// trade rather than a shortcut. What you see is the *ratio* between vertical
	// and horizontal spacing, not the beam count — sixty-four rings inside a fixed
	// point budget forces the azimuth step up to meet them, which lands at roughly
	// one-to-one and turns the scan back into static. Halving the fan buys the
	// anisotropy back and spends the saving on stations, which is what makes the
	// room readable.
	beams: 32,
	fovTop: 2.0,             // degrees above horizontal
	fovBottom: - 24.8,       // and below. Asymmetric, ground-biased, as built.
	azimuthStep: 0.10,       // degrees, solved down to the budget at build
	range: 60,               // metres
	rangeNoise: 0.012,       // metres of jitter, along the ray and nowhere else
	// A return needs backscatter. A beam arriving almost parallel to a surface
	// mostly does not come back, which is why real scans thin out and then fail
	// across grazing floors and far walls.
	grazeCutoff: 0.12,
	budget: 200000,          // hard cap; azimuth is relaxed until the set fits
	// Fraction of the set actually drawn. Points are shuffled at build time, so a
	// prefix of the buffer is a uniform random subset of the room and the LOD is a
	// single drawRange call — no rebuild, no popping, no spatial bias.
	lod: 1.0,

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
	settle: 0.0,             // damage decay per second; 0 = permanent (§7.5)
	// Below this surviving fraction, a cell stops being a surface and starts
	// being a hole. This is the number that turns the scan from a skin into a
	// world: flight.js reads it, so what you can see through is what you can fly
	// through, and neither can drift from the other because there is only one
	// fact underneath both.
	breachAt: 0.34

};

const _c = new THREE.Color();

// Shared hit record. Two hundred thousand rays is two hundred thousand object
// allocations if this is returned fresh each time.
const _hit = { t: 0, nx: 0, ny: 0, nz: 0 };

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

		// Lit per *point*, not per fragment, and that is the difference between
		// this running and not running.
		//
		// A quarter of a million sprites at up to five pixels is roughly six
		// million fragments — with `transparent: true` there is no early-z, so
		// every one of them ran the full rig: eight tube lights, six practicals,
		// the caustic field and a three-tap volumetric raymarch. On a 2019
		// integrated part that is not a slow frame, it is a stopped one, and a
		// stopped frame reads to the player as the controls not responding.
		//
		// A point is at most a few pixels across, so per-vertex and per-fragment
		// lighting are visually identical here. Moving the whole rig up a stage
		// turns six million shading invocations into two hundred and thirty
		// thousand, and dropping `transparent` puts the cloud back in the opaque
		// pass where early-z can reject it.
		this.material = new THREE.ShaderMaterial( {
			uniforms: this.uniforms,
			transparent: false,
			depthWrite: true,
			blending: THREE.NormalBlending,
			vertexShader: '#define LIGHT_NO_DERIVATIVES\n' + LIGHT_GLSL + /* glsl */`
				attribute vec3 aNormal;
				attribute float aDamage;
				attribute float aSeed;

				uniform float uPointSize;
				uniform float uSizeFalloff;
				uniform float uMinPixels;
				uniform float uMaxPixels;
				uniform float uLoosen;
				uniform float uPixelRatio;
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

				varying vec3 vColor;
				varying float vAlpha;

				void main() {
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

					// The LIDAR ramp: cold and dense at the floor, hot at the ceiling.
					// It is a convention rather than a lighting model and that is
					// exactly why it earns its place — height reads instantly and
					// unambiguously, which is what a 6DOF room most needs and what a
					// point cloud is otherwise worst at.
					float h = clamp( ( p.y - uRampFloor ) / max( 0.001, uRampCeil - uRampFloor ), 0.0, 1.0 );
					vec3 ramp = h < 0.5
						? mix( uRampLow, uRampMid, h * 2.0 )
						: mix( uRampMid, uRampHigh, ( h - 0.5 ) * 2.0 );

					// The ramp is the read; the rig is the room. Mixing rather than
					// choosing keeps a scanned wall reacting to a cove strip crossing
					// it, which is what stops the world looking like a diagram.
					Surface sf;
					sf.pos = p;
					sf.normal = normalize( aNormal );
					sf.albedo = ramp;
					sf.gloss = 0.0;
					sf.specular = 0.0;
					vec3 color = mix( ramp * uGlow, directLighting( sf, uCamPos ) + causticLight( sf ), uLit );

					// Never quite still. A dead-static cloud reads as geometry; one
					// that shimmers reads as something being sensed.
					float tw = sin( uTime * ( 1.4 + aSeed * 3.3 ) + aSeed * 90.0 ) * 0.5 + 0.5;
					color *= 1.0 - uSparkle + uSparkle * tw * 1.6;

					color = mix( color, applyFog( color, uCamPos, p ), uFogMix );
					color += vec3( 1.0, 0.42, 0.15 ) * aDamage * 0.8;

					vColor = color;
					vAlpha = 1.0 - aDamage * 0.75;

					vec4 mv = viewMatrix * vec4( p, 1.0 );
					float dist = max( - mv.z, 0.05 );

					// Between constant-world-size, which vanishes at range, and
					// constant-pixel-size, which turns distance into a wall of dots.
					float px = uPointSize * uPixelRatio / pow( dist, uSizeFalloff );
					gl_PointSize = clamp( px, uMinPixels * uPixelRatio, uMaxPixels * uPixelRatio );
					gl_Position = projectionMatrix * mv;
				}
			`,
			fragmentShader: /* glsl */`
				varying vec3 vColor;
				varying float vAlpha;

				void main() {
					// Round points. Square ones read as pixels and give the whole
					// thing away as a rasteriser rather than a return. Discard rather
					// than blend, so the cloud stays opaque and early-z works.
					vec2 q = gl_PointCoord * 2.0 - 1.0;
					if ( dot( q, q ) > 1.0 ) discard;
					gl_FragColor = vec4( vColor * vAlpha, 1.0 );
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
	// Occupy the room with a survey rather than a texture.
	//
	// The previous sampler walked every collider face on a Cartesian grid, which
	// produces a point-ified mesh: evenly dense everywhere, no voids, no rings,
	// and identical density at one metre and forty. None of those are properties
	// of a room — they are properties of a scanner, and getting them requires
	// actually casting the rays.
	//
	// What that buys, in order of how much it matters:
	//
	//   1. Occlusion shadows. A return exists only where a beam reached, so every
	//      pier and plinth throws a wedge of absent points behind it. This is the
	//      single most recognisable thing about the reference, and no amount of
	//      surface sampling produces it.
	//   2. Rings. A fixed vertical fan on a spinning head paints conic sections —
	//      concentric arcs on the floor, hyperbolic curves up a wall — never a
	//      grid aligned to the architecture.
	//   3. Angular density. Points diverge with range, so near surfaces are dense
	//      and far ones sparse, which is most of how a scan conveys depth.
	//
	// Several stations, unioned, is also how a real survey is done: one setup
	// leaves too much in shadow, so the scanner is moved and the clouds are
	// registered together.
	build( solver, panels = [] ) {

		const R = this.room;

		// Colliders, flattened once, plus the panels — which are not solver
		// geometry and would otherwise be the one part of the room no beam can
		// find.
		const boxes = solver.boxes.slice();

		for ( const p of panels ) {

			boxes.push( { cx: p.center.x, cy: p.center.y, cz: p.center.z,
				hx: p.half.x, hy: p.half.y, hz: p.half.z } );

		}

		this._boxes = boxes;
		this._planes = solver.planes;
		this._bounds = {
			lo: { x: - R.halfW - 0.4, y: R.pool.bottom - 0.4, z: - R.halfD - 0.4 },
			hi: { x: R.halfW + 0.4, y: R.height + 0.4, z: R.halfD + 0.4 }
		};

		const stations = this.stations || ScanField.defaultStations( R );
		this.stations = stations;

		// Solve the azimuth against the budget instead of sweeping and discarding.
		// The obvious loop — sweep, check, coarsen, repeat — ran the survey seven
		// times over and cost two and a half seconds of frozen page for a result
		// that one pass produces in two hundred milliseconds. A coarse pilot
		// measures the hit rate; the rest is arithmetic.
		const pilot = [];
		const pilotAz = 4.0;
		this._sweep( stations[ 0 ], pilot, pilotAz );

		const pilotRays = SCAN.beams * Math.round( 360 / pilotAz );
		const hitRate = Math.max( 0.02, ( pilot.length / 7 ) / pilotRays );
		const colsAllowed = SCAN.budget / ( stations.length * SCAN.beams * hitRate );

		let az = Math.max( SCAN.azimuthStep, 360 / Math.max( 32, colsAllowed ) );

		const pts = [];
		for ( const st of stations ) this._sweep( st, pts, az );

		this.azimuthUsed = az;
		// Vertical spacing over horizontal. Real hardware is about five to one and
		// that ratio is the difference between a scan and a fog of dots.
		this.anisotropy = + ( ( ( SCAN.fovTop - SCAN.fovBottom ) / ( SCAN.beams - 1 ) ) / az ).toFixed( 2 );
		this.rays = Math.round( stations.length * SCAN.beams * ( 360 / az ) );
		this._shuffle( pts );

		const n = pts.length / 7;
		this.count = n;

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
		this.setLod( SCAN.lod );

		this._buildHash();
		return n;

	}

	// Where the scanner was set up. One station is the most faithful thing to do
	// and leaves half the room in shadow; a survey uses several and registers
	// them, which is what these are. Heights and tilts vary because the sensor's
	// fan is ground-biased — a level head at eye height never sees a ceiling.
	static defaultStations( R ) {

		const d = Math.PI / 180;
		return [
			{ x: 0, y: 6.4, z: 7.0, tilt: - 6 * d, yaw: 0 },
			{ x: 0, y: 6.4, z: - 7.0, tilt: - 6 * d, yaw: Math.PI },
			{ x: - 8.5, y: 1.1, z: - 2.0, tilt: 34 * d, yaw: 0.6 },
			{ x: 8.5, y: 1.1, z: 4.0, tilt: 34 * d, yaw: - 2.1 }
		];

	}

	// One revolution. Sixty-four beams, one azimuth column at a time.
	_sweep( st, out, azStep ) {

		const beams = SCAN.beams;
		const top = SCAN.fovTop * Math.PI / 180;
		const bottom = SCAN.fovBottom * Math.PI / 180;
		const cols = Math.max( 8, Math.round( 360 / azStep ) );
		const ct = Math.cos( st.tilt ), stl = Math.sin( st.tilt );

		for ( let b = 0; b < beams; b ++ ) {

			const el = bottom + ( top - bottom ) * ( b / ( beams - 1 ) );
			const ce = Math.cos( el ), se = Math.sin( el );

			for ( let c = 0; c < cols; c ++ ) {

				const a = st.yaw + ( c / cols ) * Math.PI * 2;

				// Beam direction in the head's frame, then pitched by the mount.
				const fx = ce * Math.sin( a ), fy = se, fz = ce * Math.cos( a );
				const dx = fx;
				const dy = fy * ct - fz * stl;
				const dz = fy * stl + fz * ct;

				if ( ! this._cast( st.x, st.y, st.z, dx, dy, dz ) ) continue;

				// Grazing incidence returns little or nothing. This is why a real
				// scan frays out across a floor rather than ending at a clean edge.
				const cosI = Math.abs( dx * _hit.nx + dy * _hit.ny + dz * _hit.nz );
				if ( cosI < SCAN.grazeCutoff ) continue;
				if ( Math.random() > Math.min( 1, cosI * 2.4 ) ) continue;

				// Range noise lives along the ray and nowhere else — the sensor is
				// uncertain about distance, not about direction.
				const t = _hit.t + ( Math.random() - 0.5 ) * SCAN.rangeNoise * 2;

				this._push( out, st.x + dx * t, st.y + dy * t, st.z + dz * t,
					_hit.nx, _hit.ny, _hit.nz );

			}

		}

	}

	// Nearest hit against the room's half-spaces and boxes.
	_cast( ox, oy, oz, dx, dy, dz ) {

		let best = SCAN.range, bnx = 0, bny = 0, bnz = 0, found = false;
		const B = this._bounds;

		for ( const pl of this._planes ) {

			const den = dx * pl.nx + dy * pl.ny + dz * pl.nz;
			if ( den > - 1e-6 ) continue;                        // facing away
			const t = ( pl.d - ( ox * pl.nx + oy * pl.ny + oz * pl.nz ) ) / den;
			if ( t <= 0.05 || t >= best ) continue;

			// A half-space is infinite; the room is not.
			const hx = ox + dx * t, hy = oy + dy * t, hz = oz + dz * t;
			if ( hx < B.lo.x || hx > B.hi.x || hy < B.lo.y || hy > B.hi.y || hz < B.lo.z || hz > B.hi.z ) continue;

			best = t; bnx = pl.nx; bny = pl.ny; bnz = pl.nz; found = true;

		}

		for ( const b of this._boxes ) {

			// Cheap reject before the slab test. A ray only cares about a box whose
			// centre lies ahead of it and nearer than the best hit so far, and that
			// is six flops against the slab test's forty. With thirty-odd colliders
			// and two hundred thousand rays it is the difference between a build you
			// wait through and one you do not notice.
			const ex = b.cx - ox, ey = b.cy - oy, ez = b.cz - oz;
			const along = ex * dx + ey * dy + ez * dz;
			const reach = b._r || ( b._r = Math.sqrt( b.hx * b.hx + b.hy * b.hy + b.hz * b.hz ) );
			if ( along + reach < 0.05 || along - reach > best ) continue;
			// And a perpendicular reject: the ray must pass within the box's own
			// bounding sphere.
			const px2 = ex - dx * along, py2 = ey - dy * along, pz2 = ez - dz * along;
			if ( px2 * px2 + py2 * py2 + pz2 * pz2 > reach * reach ) continue;

			let tmin = 0.05, tmax = best, axis = 0, sign = 1;

			for ( let a = 0; a < 3; a ++ ) {

				const o = a === 0 ? ox : a === 1 ? oy : oz;
				const dd = a === 0 ? dx : a === 1 ? dy : dz;
				const c = a === 0 ? b.cx : a === 1 ? b.cy : b.cz;
				const h = a === 0 ? b.hx : a === 1 ? b.hy : b.hz;

				if ( Math.abs( dd ) < 1e-9 ) { if ( Math.abs( o - c ) > h ) { tmin = tmax + 1; break; } continue; }

				let t1 = ( c - h - o ) / dd, t2 = ( c + h - o ) / dd, s = - 1;
				if ( t1 > t2 ) { const q = t1; t1 = t2; t2 = q; s = 1; }
				if ( t1 > tmin ) { tmin = t1; axis = a; sign = s; }
				if ( t2 < tmax ) tmax = t2;
				if ( tmin > tmax ) break;

			}

			if ( tmin > tmax || tmin >= best || tmin <= 0.05 ) continue;

			best = tmin; found = true;
			bnx = axis === 0 ? sign : 0;
			bny = axis === 1 ? sign : 0;
			bnz = axis === 2 ? sign : 0;

		}

		if ( ! found ) return false;
		_hit.t = best; _hit.nx = bnx; _hit.ny = bny; _hit.nz = bnz;
		return true;

	}

	_push( out, x, y, z, nx, ny, nz ) {

		out.push( x, y, z, nx, ny, nz, Math.random() );

	}

	// Fisher-Yates over the seven-float records, before anything is uploaded.
	// This is what makes the LOD free: any prefix of a shuffled set is an unbiased
	// sample of the room, so dropping to 45% thins the whole world evenly instead
	// of deleting a wall.
	_shuffle( a ) {

		for ( let i = a.length / 7 - 1; i > 0; i -- ) {

			const j = Math.floor( Math.random() * ( i + 1 ) );
			for ( let k = 0; k < 7; k ++ ) {

				const t = a[ i * 7 + k ]; a[ i * 7 + k ] = a[ j * 7 + k ]; a[ j * 7 + k ] = t;

			}

		}

	}

	setLod( f ) {

		SCAN.lod = Math.max( 0.05, Math.min( 1, f ) );
		this.drawn = Math.round( this.count * SCAN.lod );
		this.geometry.setDrawRange( 0, this.drawn );

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

		// Occupancy, maintained incrementally. Asking "is this cell still a
		// surface" has to be O(1) — it is answered once per collision iteration
		// per plane per frame, and walking the point list there would cost more
		// than the whole flight model.
		this.cellTotal = new Int32Array( cells );
		this.cellAlive = new Int32Array( cells );

		for ( let c = 0; c < cells; c ++ ) {

			this.cellTotal[ c ] = counts[ c + 1 ] - counts[ c ];
			this.cellAlive[ c ] = this.cellTotal[ c ];

		}

	}

	// Has this place stopped being a wall?
	//
	// Queried with a point *on the surface*, never with the player's position: a
	// cell holding no samples answers "solid", deliberately and conservatively,
	// because no data is not the same as no wall and the alternative is falling
	// out of the world wherever the sampler happened to miss.
	passable( x, y, z ) {

		if ( ! this.cellTotal ) return false;
		const c = this._cell( x, y, z );
		if ( c < 0 ) return false;
		const t = this.cellTotal[ c ];
		if ( t === 0 ) return false;
		return this.cellAlive[ c ] / t < SCAN.breachAt;

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

						if ( was < SCAN.dropAt && this.damage[ p ] >= SCAN.dropAt ) {

							this.eroded ++;
							const home = this._cell( this.px[ p ], this.py[ p ], this.pz[ p ] );
							if ( home >= 0 ) this.cellAlive[ home ] --;

						}

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
		if ( this.cellTotal ) this.cellAlive.set( this.cellTotal );
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
