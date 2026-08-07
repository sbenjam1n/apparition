// Shards.
//
// The thing this replaces was a brick-throwing simulator, and the reason is
// structural rather than cosmetic: everything the funnel touched was a rigid
// solver body, so "more debris" meant more contacts, and the solver caps at 640
// bodies with a contact graph behind each one. You cannot make the feeling of
// something being torn to pieces out of eight cuboids.
//
// The way out is the one the tornado literature already describes. Wind
// engineering sorts debris into compact, plate and rod classes and rates each by
// the Tachikawa number — the ratio of aerodynamic force to weight, which scales
// with area over mass. A brick has a terrible ratio and flies ballistically; a
// splinter has an enormous one and goes wherever the air goes. The large-eddy
// studies of tornado vortices find the same split from the other end: heavy
// debris is thrown out of the vortex by its own inertia, while light debris is
// trapped circulating in the core, and it is that fine material in the corner
// flow that actually alters the wind field.
//
// So: two representations, split exactly where the physics splits them.
//
//   * Rigid bodies (avbd.js) stay the compact class. Few, heavy, ballistic, and
//     they collide with everything properly.
//   * Shards live here. Thousands, light, no pairwise anything — they test
//     against static planes and the three weak panels and nothing else. They are
//     the plate class, they are what the funnel actually carries, and they are
//     what a jet is made of.
//
// Rendering is a velocity-aligned stretched quad, which is the standard streak
// technique and the single largest lever on whether fast debris reads as sharp
// or as floating boxes. There is no per-shard orientation stored: the long axis
// is the velocity, the short axis is its cross product with the view vector, and
// the silhouette tapers to points at both ends. One draw call for the lot.

import * as THREE from 'three';
import { LIGHT_GLSL } from './lighting.js';
import { materialTint } from './room.js';

export const SHRED = {

	// --- look ---------------------------------------------------------------
	stretch: 0.026,          // metres of length per m/s of speed
	minLength: 0.10,
	maxLength: 0.9,
	width: 0.022,            // half-width of the cross-section at its widest
	// A minimum angular width, in radians, so a shard never falls under a pixel.
	// Without it the field is invisible at any distance: at 10m a 0.02m sliver is
	// about one pixel across and vanishes into the background, which measured as
	// "1140 shards a second channelling" and rendered as an empty room. Thin
	// geometry always needs a screen-space floor.
	minAngular: 0.0032,
	hotFade: 5.0,            // 1/s; shards leave the disc glowing and cool down

	// --- flight -------------------------------------------------------------
	// Light plate debris decelerates hard — that is the whole content of a high
	// Tachikawa number, and it is why a jet has reach but not infinite reach.
	drag: 0.55,              // 1/s
	gravity: - 9.81,
	lifeMin: 1.1,
	lifeMax: 2.6,

	// --- impact -------------------------------------------------------------
	bounce: 0.26,
	friction: 0.6,
	sparkLife: 0.16,
	// A jet is billed in the same currency as a thrown chunk — joules — so the
	// two are comparable rather than each being a special case. The scale is what
	// makes cutting a wall open take a beat instead of a frame.
	strikeScale: 0.055,
	minStrikeSpeed: 6.0

};

const _hn = new Float32Array( 3 );

export class ShredField {

	constructor( scene, rig, max = 2600 ) {

		this.max = max;
		this.cursor = 0;
		this.live = 0;
		this.struck = 0;         // strikes this frame, for the readout

		this.px = new Float32Array( max );
		this.py = new Float32Array( max );
		this.pz = new Float32Array( max );
		this.vx = new Float32Array( max );
		this.vy = new Float32Array( max );
		this.vz = new Float32Array( max );
		this.life = new Float32Array( max );
		this.decay = new Float32Array( max );
		this.mass = new Float32Array( max );
		this.scale = new Float32Array( max );
		this.hot = new Float32Array( max );
		// Per-shard drag multiplier. This is the Tachikawa number in one float:
		// a glass needle has an enormous area-to-mass ratio and stops in the air,
		// a steel grain has almost none and carries.
		this.dragMul = new Float32Array( max );
		this.tint = new Float32Array( max * 3 );
		// 0 = flying free, 1 = bound to the disc and orbiting the apex.
		this.bound = new Uint8Array( max );
		this.phase = new Float32Array( max );
		this.band = new Float32Array( max );

		// Per instance, in slot order.
		this.aVel = new Float32Array( max * 3 );
		this.aData = new Float32Array( max * 3 );   // life, scale, hot
		this.aTint = new Float32Array( max * 3 );

		const geo = new THREE.PlaneGeometry( 1, 1 );
		this.velAttr = new THREE.InstancedBufferAttribute( this.aVel, 3 );
		this.dataAttr = new THREE.InstancedBufferAttribute( this.aData, 3 );
		this.tintAttr = new THREE.InstancedBufferAttribute( this.aTint, 3 );
		for ( const a of [ this.velAttr, this.dataAttr, this.tintAttr ] ) a.setUsage( THREE.DynamicDrawUsage );
		geo.setAttribute( 'aVel', this.velAttr );
		geo.setAttribute( 'aData', this.dataAttr );
		geo.setAttribute( 'aTint', this.tintAttr );

		this.uniforms = Object.assign( {}, rig.uniforms, {
			uCamPos: rig.uniforms.uCamPos,
			uStretch: { value: SHRED.stretch },
			uMinLength: { value: SHRED.minLength },
			uMaxLength: { value: SHRED.maxLength },
			uWidth: { value: SHRED.width },
			uMinAngular: { value: SHRED.minAngular },
			uHotColor: { value: new THREE.Color( 0xffa05c ) }
		} );

		this.material = new THREE.ShaderMaterial( {
			uniforms: this.uniforms,
			transparent: true,
			depthWrite: false,
			side: THREE.DoubleSide,
			blending: THREE.NormalBlending,
			vertexShader: /* glsl */`
				attribute vec3 aVel;
				attribute vec3 aData;
				attribute vec3 aTint;
				uniform vec3 uCamPos;
				uniform float uStretch;
				uniform float uMinLength;
				uniform float uMaxLength;
				uniform float uWidth;
				uniform float uMinAngular;

				varying vec2 vLocal;
				varying vec3 vWorld;
				varying vec3 vTint;
				varying float vHot;
				varying vec3 vNrm;

				void main() {
					vLocal = position.xy;
					vTint = aTint;
					vHot = aData.z;

					vec3 origin = vec3( instanceMatrix[ 3 ][ 0 ], instanceMatrix[ 3 ][ 1 ], instanceMatrix[ 3 ][ 2 ] );

					float speed = length( aVel );
					// The long axis is where it is going. A shard sitting still has no
					// direction to be sharp along, so it falls back to the view up and
					// reads as a fleck rather than a needle — which is correct, a piece
					// of grit at rest is not a blade.
					vec3 toCam = uCamPos - origin;
					float camDist = length( toCam );
					toCam /= max( camDist, 1e-4 );

					vec3 fwd = speed > 0.05 ? aVel / speed : vec3( 0.0, 1.0, 0.0 );
					vec3 side = cross( fwd, toCam );
					float sl = length( side );
					if ( sl < 1e-3 ) { side = normalize( cross( fwd, vec3( 0.0, 0.0, 1.0 ) ) ); } else { side /= sl; }

					// Grow both with distance so the shard holds a minimum footprint on
					// screen. Perspective still shrinks it; this only stops it
					// disappearing entirely.
					float floorW = camDist * uMinAngular;
					float len = max( clamp( speed * uStretch, uMinLength, uMaxLength ) * aData.y, floorW * 16.0 );
					float wid = max( uWidth * aData.y, floorW );

					// Then hold the aspect. This is the difference between a splinter
					// and a lozenge: a slow shard clamps to the minimum length while
					// its width stays put, and anything under about eight-to-one stops
					// reading as sharp at all. Note the factor of two: wid is a
					// half-width against a full length, and getting that wrong is how
					// a needle comes out as a diamond.
					wid = min( wid, len * 0.055 );

					// The quad stays rectangular here and the needle silhouette is cut
					// in the fragment stage. Tapering the vertices instead is the
					// obvious thing and it is wrong: a PlaneGeometry(1,1) has four
					// vertices and every one of them is at |y| = 0.5, so a taper that
					// goes to zero at the tips goes to zero at all four corners and
					// collapses the quad to a line of zero width. That renders as
					// nothing at all while every readout still says a thousand shards
					// a second are leaving.
					vec3 wp = origin + fwd * ( position.y * len ) + side * ( position.x * wid * 2.0 );

					// Face the camera for lighting purposes; the geometry is a ribbon,
					// so a real normal would flip and strobe as it tumbles.
					vNrm = toCam;
					vWorld = wp;

					gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
				}
			`,
			fragmentShader: LIGHT_GLSL + /* glsl */`
				varying vec2 vLocal;
				varying vec3 vWorld;
				varying vec3 vTint;
				varying float vHot;
				varying vec3 vNrm;
				uniform vec3 uCamPos;
				uniform vec3 uHotColor;

				void main() {
					// The needle. Half-width tapers to a point at both tips, and the
					// edge stays hard — a soft falloff here would turn a field of
					// splinters back into a field of puffs, which is the thing this
					// whole file exists to stop being.
					float halfW = 1.0 - abs( vLocal.y ) * 2.0;
					halfW *= halfW;
					float edge = halfW - abs( vLocal.x ) * 2.0;
					if ( edge <= 0.0 ) discard;

					Surface s;
					s.pos = vWorld;
					s.normal = normalize( vNrm );
					s.albedo = vTint;
					s.gloss = 0.62;
					s.specular = 0.55;

					vec3 color = directLighting( s, uCamPos ) + causticLight( s );
					// Restrained, and it took two goes. At 1.5 against a room this dark
					// the hot term swamped the material tint completely and every shard
					// of every material came out the same orange — which defeats the
					// point of tinting them by what they were torn from.
					color += uHotColor * vHot * 0.5;
					// A floor of self-colour. The room is deliberately near-black and a
					// shard lit only by the rig disappears into it; this keeps the
					// material readable without turning the field into a light source.
					color += vTint * 0.16;
					color = applyFog( color, uCamPos, vWorld );

					gl_FragColor = vec4( color, min( 1.0, edge * 6.0 ) );
				}
			`
		} );

		this.mesh = new THREE.InstancedMesh( geo, this.material, max );
		this.mesh.instanceMatrix.setUsage( THREE.DynamicDrawUsage );
		this.mesh.frustumCulled = false;
		this.mesh.count = 0;
		this.mesh.renderOrder = 1;
		scene.add( this.mesh );

		this._m = new THREE.Matrix4();

	}

	// Push out along _hn, report the strike, spend most of the shard.
	_land( i, nx, ny, nz, depth, speed2, onStrike, material, panel ) {

		const hx = _hn[ 0 ], hy = _hn[ 1 ], hz = _hn[ 2 ];
		const into = this.vx[ i ] * hx + this.vy[ i ] * hy + this.vz[ i ] * hz;

		if ( onStrike && - into > SHRED.minStrikeSpeed ) {

			onStrike( nx + hx * depth, ny + hy * depth, nz + hz * depth, hx, hy, hz,
				0.5 * this.mass[ i ] * into * into, material, panel );
			this.struck ++;

		}

		this.px[ i ] = nx + hx * depth;
		this.py[ i ] = ny + hy * depth;
		this.pz[ i ] = nz + hz * depth;

		this.vx[ i ] = ( this.vx[ i ] - hx * into * ( 1 + SHRED.bounce ) ) * SHRED.friction;
		this.vy[ i ] = ( this.vy[ i ] - hy * into * ( 1 + SHRED.bounce ) ) * SHRED.friction;
		this.vz[ i ] = ( this.vz[ i ] - hz * into * ( 1 + SHRED.bounce ) ) * SHRED.friction;

		if ( speed2 > 90 ) {

			this.hot[ i ] = 1;
			this.decay[ i ] = Math.max( this.decay[ i ], 1 / SHRED.sparkLife );

		}

		return true;

	}

	_alloc() {

		// Ring allocation. Overrunning steals the oldest, which is right for this:
		// a jet that outruns the pool should thin at the tail, not stop at the
		// muzzle.
		const i = this.cursor;
		this.cursor = ( this.cursor + 1 ) % this.max;
		return i;

	}

	_seed( i, x, y, z, vx, vy, vz, kind, scale, life ) {

		this.px[ i ] = x; this.py[ i ] = y; this.pz[ i ] = z;
		this.vx[ i ] = vx; this.vy[ i ] = vy; this.vz[ i ] = vz;
		this.life[ i ] = 1;
		this.decay[ i ] = 1 / life;
		this.scale[ i ] = scale;
		this.hot[ i ] = 1;
		this.bound[ i ] = 0;
		this.dragMul[ i ] = 1;

		const c = materialTint( kind );
		this.tint[ i * 3 ] = c.r; this.tint[ i * 3 + 1 ] = c.g; this.tint[ i * 3 + 2 ] = c.b;

	}

	// Something came apart. Used when the horizon takes a body: it does not
	// vanish, it is visibly reduced to pieces that then spiral in.
	burst( x, y, z, vx, vy, vz, mass, kind, radius = 0.3 ) {

		// Piece count from mass, sublinearly — a bench should read as more debris
		// than a paver without producing forty times as much of it.
		const n = Math.max( 6, Math.min( 90, Math.round( 7 + Math.pow( mass, 0.62 ) * 2.2 ) ) );
		const spread = 2.2 + Math.min( 9, mass * 0.035 );
		const pieceMass = mass / n;

		for ( let k = 0; k < n; k ++ ) {

			const i = this._alloc();

			// Spherical shell, so the burst has a surface rather than a centre.
			const u = Math.random() * 2 - 1;
			const th = Math.random() * Math.PI * 2;
			const r = Math.sqrt( Math.max( 0, 1 - u * u ) );
			const dx = r * Math.cos( th ), dy = u, dz = r * Math.sin( th );

			this._seed( i,
				x + dx * radius, y + dy * radius, z + dz * radius,
				vx + dx * spread, vy + dy * spread, vz + dz * spread,
				kind,
				0.5 + Math.random() * 0.9,
				SHRED.lifeMin + Math.random() * ( SHRED.lifeMax - SHRED.lifeMin ) );

			this.mass[ i ] = pieceMass;

		}

		return n;

	}

	// The channelled stream. Emitted along the axis with a controlled cone, and
	// deliberately not a puff: the pieces leave fast, in line, and stay sharp.
	//
	// The helix comes from a *rotating emitter*, not from tangential velocity, and
	// the difference is the whole weapon. Adding real tangential speed was the
	// first attempt: at 0.62 of a 62 m/s muzzle it looked superb and put the
	// stream two and a half metres off-axis over four metres of flight, so the jet
	// simply missed the wall it was pointed at — measured as the panel test going
	// from a 0.5s cut to never activating at all. Here the emission *angle*
	// advances every shard, so consecutive pieces are laid around a turning circle
	// and the stream traces a corkscrew through space while every individual shard
	// flies straight at what you aimed at. A small real tangential term survives
	// only so the streaks are not seen perfectly end-on.
	jet( ox, oy, oz, dx, dy, dz, rx, ry, rz, ux, uy, uz, count, kind, speed, spread, pieceMass, sizeScale, dragMul = 1, swirl = 0, phase = 0 ) {

		let emitted = 0;

		for ( let k = 0; k < count; k ++ ) {

			const i = this._alloc();

			// Sample the cone as an annulus rather than a disc, so the jet has a
			// wall and a hollow — a braid rather than a wash. The suction-vortex
			// literature is the reason: real damage streaks are narrow and
			// concentrated, not evenly spread across the funnel. Two arms, half a
			// turn apart, so it reads as a braid rather than a tube.
			const a = phase + ( k & 1 ? Math.PI : 0 ) + ( k / count ) * 0.9;
			const rr = ( 0.5 + Math.random() * 0.5 ) * spread;
			const jx = ( rx * Math.cos( a ) + ux * Math.sin( a ) ) * rr;
			const jy = ( ry * Math.cos( a ) + uy * Math.sin( a ) ) * rr;
			const jz = ( rz * Math.cos( a ) + uz * Math.sin( a ) ) * rr;

			const sp = speed * ( 0.82 + Math.random() * 0.36 );

			// Tangential: perpendicular to both the axis and the offset. Kept small
			// on purpose — enough that a shard fired straight down the view axis
			// still presents some length rather than projecting to a dot, not
			// enough to walk the stream off the target.
			const tw = swirl * sp;
			const tx = ( dy * jz - dz * jy );
			const ty = ( dz * jx - dx * jz );
			const tz = ( dx * jy - dy * jx );
			const tl = Math.sqrt( tx * tx + ty * ty + tz * tz ) || 1;

			const vx = ( dx + jx ) * sp + tx / tl * tw;
			const vy = ( dy + jy ) * sp + ty / tl * tw;
			const vz = ( dz + jz ) * sp + tz / tl * tw;

			this._seed( i,
				ox + dx * 0.5 + jx * 0.4, oy + dy * 0.5 + jy * 0.4, oz + dz * 0.5 + jz * 0.4,
				vx, vy, vz, kind,
				sizeScale * ( 0.7 + Math.random() * 0.7 ),
				SHRED.lifeMin + Math.random() * ( SHRED.lifeMax - SHRED.lifeMin ) );

			this.mass[ i ] = pieceMass;
			this.dragMul[ i ] = dragMul;
			emitted ++;

		}

		return emitted;

	}

	// Shards the disc is carrying. Bound pieces do not collide and do not fall;
	// they orbit the apex, and their population is what makes the disc visible as
	// a thing rather than as a number on a readout.
	bind( count, kind, sizeScale ) {

		for ( let k = 0; k < count; k ++ ) {

			const i = this._alloc();
			this._seed( i, 0, 0, 0, 0, 0, 0, kind, sizeScale * ( 0.5 + Math.random() * 0.8 ), 9e9 );
			this.bound[ i ] = 1;
			this.decay[ i ] = 0;
			this.phase[ i ] = Math.random() * Math.PI * 2;
			this.band[ i ] = Math.random();
			this.mass[ i ] = 0;

		}

	}

	// Drop `count` bound shards back out of the disc, thrown along the axis. Used
	// when the disc spends mass, so what leaves the disc is visibly what was in it.
	releaseBound( count, dx, dy, dz, speed ) {

		let n = 0;

		for ( let i = 0; i < this.max && n < count; i ++ ) {

			if ( this.bound[ i ] !== 1 ) continue;
			this.bound[ i ] = 0;
			this.decay[ i ] = 1 / ( SHRED.lifeMin + Math.random() * ( SHRED.lifeMax - SHRED.lifeMin ) );
			this.vx[ i ] = dx * speed; this.vy[ i ] = dy * speed; this.vz[ i ] = dz * speed;
			n ++;

		}

		return n;

	}

	boundCount() {

		let n = 0;
		for ( let i = 0; i < this.max; i ++ ) if ( this.bound[ i ] === 1 ) n ++;
		return n;

	}

	clear() {

		this.life.fill( 0 );
		this.bound.fill( 0 );
		this.mesh.count = 0;

	}

	// Resolve a shard against one axis-aligned box. Returns the penetration depth
	// on the shallowest axis and writes that axis's outward normal into _hn, or
	// -1 if the point is outside. Boxes are how a shard learns that a pier, a
	// plinth or a weak panel is there — a slab test would be more correct for a
	// fast shard, but at 62 m/s and a 1/60 step the travel is 1m, and a shard
	// that skips a 0.3m pier once in a while is invisible where a per-shard
	// swept test would not be free.
	_boxDepth( x, y, z, b ) {

		const dx = ( b.hx !== undefined ? b.hx : b.half.x ) - Math.abs( x - ( b.cx !== undefined ? b.cx : b.center.x ) );
		if ( dx <= 0 ) return - 1;
		const dy = ( b.hy !== undefined ? b.hy : b.half.y ) - Math.abs( y - ( b.cy !== undefined ? b.cy : b.center.y ) );
		if ( dy <= 0 ) return - 1;
		const dz = ( b.hz !== undefined ? b.hz : b.half.z ) - Math.abs( z - ( b.cz !== undefined ? b.cz : b.center.z ) );
		if ( dz <= 0 ) return - 1;

		const cx = b.cx !== undefined ? b.cx : b.center.x;
		const cy = b.cy !== undefined ? b.cy : b.center.y;
		const cz = b.cz !== undefined ? b.cz : b.center.z;

		if ( dx <= dy && dx <= dz ) { _hn[ 0 ] = x < cx ? - 1 : 1; _hn[ 1 ] = 0; _hn[ 2 ] = 0; return dx; }
		if ( dy <= dz ) { _hn[ 0 ] = 0; _hn[ 1 ] = y < cy ? - 1 : 1; _hn[ 2 ] = 0; return dy; }
		_hn[ 0 ] = 0; _hn[ 1 ] = 0; _hn[ 2 ] = z < cz ? - 1 : 1; return dz;

	}

	// `world` is { planes, boxes, panels } — every static thing a shard can land
	// on. `disc` describes where bound shards live: apex, axis, radius, spin.
	// `onStrike( x, y, z, nx, ny, nz, joules, material, panel )` fires for each
	// landing fast enough to count.
	update( dt, world, disc, onStrike ) {

		// Pushed every frame rather than on a slider's onChange. A route writes
		// SHRED.stretch directly and never goes near the panel, so a hook hung off
		// the panel would make exactly the parameters that look most alive under
		// modulation the four that silently refuse to move.
		this.uniforms.uStretch.value = SHRED.stretch;
		this.uniforms.uMaxLength.value = SHRED.maxLength;
		this.uniforms.uWidth.value = SHRED.width;
		this.uniforms.uMinAngular.value = SHRED.minAngular;

		const m = this._m;
		let slot = 0, live = 0;
		this.struck = 0;

		const drag = Math.max( 0, 1 - SHRED.drag * dt );
		const planes = world && world.planes ? world.planes : null;
		const boxes = world && world.boxes ? world.boxes : null;
		const panels = world && world.panels ? world.panels : null;
		const nPlanes = planes ? planes.length : 0;
		const nBoxes = boxes ? boxes.length : 0;
		const nPanels = panels ? panels.length : 0;

		for ( let i = 0; i < this.max; i ++ ) {

			if ( this.life[ i ] <= 0 ) continue;

			live ++;

			if ( this.bound[ i ] === 1 ) {

				// Bound: a flattened orbit about the funnel axis, banded so the disc
				// has structure instead of being a uniform shell. Cheap trig, no
				// integration, no collision — this is set dressing that happens to
				// be made of the same primitive as the ammunition.
				this.phase[ i ] += dt * disc.spin * ( 0.6 + this.band[ i ] * 0.9 );

				const b = this.band[ i ];
				const r = disc.radius * ( 0.42 + b * 0.72 );
				const along = ( b - 0.5 ) * disc.thickness;
				const c = Math.cos( this.phase[ i ] ), s2 = Math.sin( this.phase[ i ] );

				const nx = disc.rx * c + disc.ux * s2;
				const ny = disc.ry * c + disc.uy * s2;
				const nz = disc.rz * c + disc.uz * s2;

				const x = disc.x + nx * r + disc.dx * along;
				const y = disc.y + ny * r + disc.dy * along;
				const z = disc.z + nz * r + disc.dz * along;

				// Velocity is written rather than integrated, purely so the streak
				// points along the orbit — the whole look depends on it.
				const tangential = disc.spin * r;
				this.vx[ i ] = ( - disc.rx * s2 + disc.ux * c ) * tangential;
				this.vy[ i ] = ( - disc.ry * s2 + disc.uy * c ) * tangential;
				this.vz[ i ] = ( - disc.rz * s2 + disc.uz * c ) * tangential;

				this.px[ i ] = x; this.py[ i ] = y; this.pz[ i ] = z;
				this.hot[ i ] = Math.max( 0.05, this.hot[ i ] - dt * SHRED.hotFade );

			} else {

				const dg = this.dragMul[ i ] === 1 ? drag : Math.max( 0, 1 - SHRED.drag * this.dragMul[ i ] * dt );
				this.vx[ i ] *= dg; this.vy[ i ] *= dg; this.vz[ i ] *= dg;
				this.vy[ i ] += SHRED.gravity * dt;

				const nx = this.px[ i ] + this.vx[ i ] * dt;
				const ny = this.py[ i ] + this.vy[ i ] * dt;
				const nz = this.pz[ i ] + this.vz[ i ] * dt;

				const speed2 = this.vx[ i ] * this.vx[ i ] + this.vy[ i ] * this.vy[ i ] + this.vz[ i ] * this.vz[ i ];

				// Static half-spaces only. No pairwise anything, no broadphase, no
				// contact graph — that is the entire reason there can be thousands
				// of these while the solver stays under a few hundred bodies.
				let hit = false;

				for ( let c = 0; c < nPlanes; c ++ ) {

					const pl = planes[ c ];
					const d = nx * pl.nx + ny * pl.ny + nz * pl.nz - pl.d;
					if ( d >= 0 ) continue;

					const into = this.vx[ i ] * pl.nx + this.vy[ i ] * pl.ny + this.vz[ i ] * pl.nz;

					if ( onStrike && - into > SHRED.minStrikeSpeed ) {

						onStrike( nx - pl.nx * d, ny - pl.ny * d, nz - pl.nz * d,
							- pl.nx, - pl.ny, - pl.nz,
							0.5 * this.mass[ i ] * into * into, pl.material );
						this.struck ++;

					}

					// Reflect and shed most of it. A splinter hitting tile does not
					// bounce like a ball; it skitters and stops.
					this.px[ i ] = nx - pl.nx * d;
					this.py[ i ] = ny - pl.ny * d;
					this.pz[ i ] = nz - pl.nz * d;

					this.vx[ i ] = ( this.vx[ i ] - pl.nx * into * ( 1 + SHRED.bounce ) ) * SHRED.friction;
					this.vy[ i ] = ( this.vy[ i ] - pl.ny * into * ( 1 + SHRED.bounce ) ) * SHRED.friction;
					this.vz[ i ] = ( this.vz[ i ] - pl.nz * into * ( 1 + SHRED.bounce ) ) * SHRED.friction;

					// Burn most of the remaining life on contact, and flash. A shard
					// that has already hit something is spent.
					if ( speed2 > 90 ) {

						this.hot[ i ] = 1;
						this.decay[ i ] = Math.max( this.decay[ i ], 1 / SHRED.sparkLife );

					}

					hit = true;
					break;

				}

					// Weak panels next, because they are the only thing in here that can be
				// damaged and a shard that stopped on the pier behind one would never
				// report the hit. An activated panel is no longer a slab — its chunks
				// are loose bodies — so it drops out of this test and the jet keeps
				// working on it through the strike callback instead.
				if ( ! hit ) {

					for ( let c = 0; c < nPanels; c ++ ) {

						const pn = panels[ c ];
						if ( pn.activated ) continue;
						const depth = this._boxDepth( nx, ny, nz, pn );
						if ( depth < 0 ) continue;
						hit = this._land( i, nx, ny, nz, depth, speed2, onStrike, pn.materialKind, pn );
						break;

					}

				}

				if ( ! hit ) {

					for ( let c = 0; c < nBoxes; c ++ ) {

						const bx = boxes[ c ];
						const depth = this._boxDepth( nx, ny, nz, bx );
						if ( depth < 0 ) continue;
						hit = this._land( i, nx, ny, nz, depth, speed2, onStrike, bx.material, null );
						break;

					}

				}

				if ( ! hit ) { this.px[ i ] = nx; this.py[ i ] = ny; this.pz[ i ] = nz; }

				this.hot[ i ] = Math.max( 0, this.hot[ i ] - dt * SHRED.hotFade );
				this.life[ i ] -= this.decay[ i ] * dt;
				if ( this.life[ i ] <= 0 ) { this.life[ i ] = 0; continue; }

			}

			m.makeTranslation( this.px[ i ], this.py[ i ], this.pz[ i ] );
			this.mesh.setMatrixAt( slot, m );

			this.aVel[ slot * 3 ] = this.vx[ i ];
			this.aVel[ slot * 3 + 1 ] = this.vy[ i ];
			this.aVel[ slot * 3 + 2 ] = this.vz[ i ];
			this.aData[ slot * 3 ] = this.life[ i ];
			this.aData[ slot * 3 + 1 ] = this.scale[ i ] * Math.min( 1, this.life[ i ] * 3 );
			this.aData[ slot * 3 + 2 ] = this.hot[ i ];
			this.aTint[ slot * 3 ] = this.tint[ i * 3 ];
			this.aTint[ slot * 3 + 1 ] = this.tint[ i * 3 + 1 ];
			this.aTint[ slot * 3 + 2 ] = this.tint[ i * 3 + 2 ];

			slot ++;

		}

		this.mesh.count = slot;
		this.mesh.instanceMatrix.needsUpdate = true;
		this.velAttr.needsUpdate = true;
		this.dataAttr.needsUpdate = true;
		this.tintAttr.needsUpdate = true;
		this.live = live;

	}

}
