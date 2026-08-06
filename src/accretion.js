// The accretion funnel.
//
// This supersedes the held-object orbit §47.3 built the body out of. The reframe:
// the apparition is not a point that carries things around itself, it is a
// tornado with an event horizon. Matter inside the funnel is drawn in and spun;
// matter that crosses the horizon is *consumed* — it leaves the world entirely
// and becomes mass in a per-material pool, fired back out later as debris.
//
// Three consequences, which are the reasons for the change:
//
//   1. Deflect-versus-consume becomes spatial rather than a button. §51.7 already
//      records the input budget as over-subscribed and warns it must not be
//      discovered late; this adds a real decision without adding a binding.
//      Where you point and how long you hold it is the whole of it.
//   2. §10.2 momentum theft survives and gets better. A body accelerating down
//      the funnel that you flick away keeps every joule you gave it. Eat it or
//      slingshot it is a choice with timing attached.
//   3. Consumption is *cheaper* than holding. A consumed body leaves the solver;
//      a held one kept generating contacts for as long as you owned it.
//
// The cost model is unchanged and still §8.3: watts scale with mass x
// acceleration, discounted by how much of the motion you did not have to
// originate. Pulling from rest is expensive; steering something already moving
// is nearly free.
//
// No visual yet, deliberately. The funnel is a rule that either feels like a
// skill or does not, and set dressing over an unproven rule only makes it harder
// to tell.

import * as THREE from 'three';
import { TUNING as FLIGHT } from './flight.js';
import { MATERIAL_KIND } from './room.js';

export const ACC = {

	// --- the funnel ---------------------------------------------------------
	reach: 7.5,              // how far down the axis the mouth extends
	mouthAngle: 0.62,        // half-angle of the cone, radians (~35°)
	horizon: 0.95,           // consumed inside this radius, always live
	intake: 90.0,            // m/s² of pull on the axis at the apex
	// Swirl and viscosity are one setting in two numbers and must be read
	// together. Swept as a pair: swirl buys turns and costs capture, viscosity
	// buys capture back. At 0.62/3 the funnel catches 13% of what enters it; at
	// 0.25/13 it catches 78% but the path barely curves. 0.50/13 sits where
	// matter makes most of a turn on the way down and the only things that get
	// away are the ones at the lip and at the mouth — which is where they are
	// supposed to get away.
	swirl: 0.50,             // share of the pull spent tangentially — the spiral
	viscosity: 13.0,         // 1/s of orbital bleed; without it the spiral is an orbit
	// The mouth trails the look direction. Without lag the funnel is a cursor and
	// plays like a hitscan cone; with it, sweeping a room drags matter after you.
	// It is a slider because it is also a third motion vector on top of §47.6's
	// two, and there is no way to know from here how much of that a neck tolerates.
	axisLag: 0.10,           // seconds
	freeSpeed: 9.0,          // §10.2: motion you did not originate costs nothing

	// --- the pool -----------------------------------------------------------
	capacity: 900,           // kg; full means the horizon stops eating
	carryWattsPerKg: 0.02,   // standing charge on what you carry
	intakeWattsPerKg: 0.08,  // §8.3, the expensive half

	// --- firing -------------------------------------------------------------
	fireSpeed: 16.0,
	// A fixed impulse budget per shot, shared across the burst. This one number
	// is the difference between a toy and the design: a spray of glass leaves
	// fast and barely moves you, while a slug of concrete eats the whole budget,
	// goes slow, and shoves *you* backward hard (§3.4).
	fireBudget: 900,         // N·s
	fireMass: 25,            // kg drawn per shot
	maxBurst: 24,
	fireSpin: 1.4,
	fireSpread: 0.07,
	rechewDelay: 0.35,       // s of immunity so fired matter is not re-eaten

	// --- readout ------------------------------------------------------------
	ventRate: 3.4,
	heatCeiling: 100,
	wattScale: 600

};

// Half-extent and specific gravity of one fired piece, per material. Same mass
// of pool becomes a spray of glass or a few concrete lumps: different body
// count, different momentum per hit, different damage. This is the only place
// the four materials mean anything mechanically, and it is why the pool is per
// material rather than one number.
const GRAIN = [
	{ half: 0.075, density: 2.4 },   // tile
	{ half: 0.110, density: 2.4 },   // concrete
	{ half: 0.045, density: 2.5 },   // glass
	{ half: 0.060, density: 7.8 }    // steel
];

export const MATERIAL_NAME = [ 'tile', 'concrete', 'glass', 'steel' ];

const KINDS = 4;

const _look = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _spawn = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

export class Accretion {

	constructor( solver, flight, debris ) {

		this.solver = solver;
		this.flight = flight;
		this.debris = debris;

		// Per-material mass, in kilograms. The whole inventory.
		this.pool = new Float32Array( KINDS );
		this.mass = 0;
		this.selected = MATERIAL_KIND.CONCRETE;

		this.axis = new THREE.Vector3( 0, 0, - 1 );

		this.watts = 0;
		this.heat = 0;              // §5.3 thermal debt; fx and audio read it
		this.peakWatts = 0;
		this.inFunnel = 0;          // bodies the funnel touched this frame
		this.consumed = 0;          // lifetime count, for the readout
		this.stalled = false;       // horizon refused something for want of room
		this.lastFireSpeed = 0;

		this.probeTarget = - 1;
		this.probeInfo = null;

		this.onConsume = null;
		this.onFire = null;
		this.onVent = null;
		this.onProbe = null;

		this._spawnedAt = new Float32Array( solver.maxBodies );
		this._clock = 0;

	}

	get saturation() {

		return ACC.capacity > 0 ? this.mass / ACC.capacity : 1;

	}

	// The only mass that still counts as carried. Flight reads this for camera
	// lag, so a full disc is a sluggish one.
	get load() {

		return this.mass;

	}

	pieceMass( kind ) {

		const g = GRAIN[ kind ];
		return 8 * g.half * g.half * g.half * g.density * 1000;

	}

	// Nearest body whose bounding sphere the view ray pierces. Cheap and good
	// enough — precision here would only make probing feel fussy.
	pick( origin, dir, maxDist ) {

		const s = this.solver;
		let best = - 1, bestT = maxDist;

		for ( let i = 0; i < s.count; i ++ ) {

			if ( s.state[ i ] === 0 ) continue;

			const ox = s.px[ i ] - origin.x, oy = s.py[ i ] - origin.y, oz = s.pz[ i ] - origin.z;
			const t = ox * dir.x + oy * dir.y + oz * dir.z;
			if ( t < 0 || t > bestT ) continue;

			const cx = ox - dir.x * t, cy = oy - dir.y * t, cz = oz - dir.z * t;
			const r = s.radius[ i ] + 0.22;
			if ( cx * cx + cy * cy + cz * cz > r * r ) continue;

			bestT = t;
			best = i;

		}

		return best;

	}

	update( input, dt, destruction ) {

		const f = this.flight;
		const s = this.solver;

		this._clock += dt;
		this.watts = 0;
		this.inFunnel = 0;
		this.stalled = false;

		_look.set( 0, 0, - 1 ).applyQuaternion( f.viewQuaternion ).normalize();

		const k = ACC.axisLag > 1e-4 ? 1 - Math.exp( - dt / ACC.axisLag ) : 1;
		this.axis.lerp( _look, k );
		if ( this.axis.lengthSq() < 1e-8 ) this.axis.copy( _look );
		this.axis.normalize();

		const origin = f.viewPosition;

		// --- probe ------------------------------------------------------------
		// Cheap sensing pulse: material response, structural weakness, thermal
		// state (§3.2). Also how a weak wall is confirmed (§7.2).

		this.probeTarget = this.pick( origin, _look, ACC.reach * 1.6 );
		this.probeInfo = null;

		const panel = destruction ? destruction.probe( origin, _look, ACC.reach * 2.2 ) : null;

		if ( panel ) {

			this.probeInfo = { kind: 'panel', panel };

		} else if ( this.probeTarget >= 0 ) {

			this.probeInfo = {
				kind: 'body',
				mass: s.mass[ this.probeTarget ],
				material: s.material[ this.probeTarget ],
				asleep: s.state[ this.probeTarget ] === 2
			};

		}

		if ( input.probe && this.onProbe ) this.onProbe( this.probeInfo );

		// --- material select ---------------------------------------------------

		if ( input.cycle ) {

			this.selected = ( this.selected + input.cycle + KINDS * 4 ) % KINDS;

		}

		// --- the funnel --------------------------------------------------------

		const ax = this.axis.x, ay = this.axis.y, az = this.axis.z;
		const open = !! input.intake;
		const reach2 = ACC.reach * ACC.reach;
		const tanA = Math.tan( ACC.mouthAngle );
		const horizon2 = ACC.horizon * ACC.horizon;

		for ( let i = 0; i < s.count; i ++ ) {

			if ( s.state[ i ] === 0 ) continue;

			const dx = s.px[ i ] - origin.x;
			const dy = s.py[ i ] - origin.y;
			const dz = s.pz[ i ] - origin.z;
			const d2 = dx * dx + dy * dy + dz * dz;

			if ( d2 > reach2 ) continue;

			// --- the horizon ---
			// A sphere, and it does not care whether you meant it. Fly into your
			// own wreckage and it goes. That is the katamari read, and it is also
			// the only garbage collector this build has: consumed bodies leave the
			// solver instead of piling up against its cap.
			//
			// Swept, not sampled. The horizon is 1.9m across and the funnel throws
			// matter through it at 20 m/s or better; at 10fps that is 2m of travel
			// in a frame, and a point-in-sphere test misses it completely. Caught
			// exactly that way — a funnel that visibly lifted a bench and then let
			// it sail straight past. The sweep runs only when the step is long
			// enough to matter, so the common case stays one distance compare.
			let hit = d2 < horizon2;

			if ( ! hit ) {

				const mx = s.vx[ i ] * dt, my = s.vy[ i ] * dt, mz = s.vz[ i ] * dt;
				const m2 = mx * mx + my * my + mz * mz;

				if ( m2 > horizon2 * 0.25 ) {

					// Segment from where it was to where it is: e + m·u, u in [0,1].
					const ex = dx - mx, ey = dy - my, ez = dz - mz;
					let u = - ( ex * mx + ey * my + ez * mz ) / m2;
					u = u < 0 ? 0 : u > 1 ? 1 : u;
					const cx = ex + mx * u, cy = ey + my * u, cz = ez + mz * u;
					hit = cx * cx + cy * cy + cz * cz < horizon2;

				}

			}

			if ( hit && this._consume( i ) ) continue;

			if ( ! open ) continue;

			const axial = dx * ax + dy * ay + dz * az;
			if ( axial <= 0 ) continue;

			const rx = dx - ax * axial, ry = dy - ay * axial, rz = dz - az * axial;
			const radial = Math.sqrt( rx * rx + ry * ry + rz * rz );

			// The cone opens from the horizon, so the mouth is continuous with the
			// thing it feeds rather than a separate volume floating in front of it.
			const coneR = ACC.horizon + tanA * axial;
			if ( radial > coneR ) continue;

			// Zero at the lip and zero at the mouth, one on the axis at the apex.
			//
			// The curve is 1-(1-x)^2 rather than x or x^2, and the shape matters
			// more than it looks. x^2 was the first attempt and it made the outer
			// half of the cone inert: at 60% of the local radius the weight fell to
			// 0.12, the pull dropped under gravity, and test blocks simply fell out
			// of the funnel rather than spiralling. This curve stays near 1 through
			// the middle and rolls off only as it approaches the lip, which is what
			// "soft lip, live funnel" actually requires.
			const wr = 1 - radial / coneR;
			const wa = 1 - axial / ACC.reach;
			const w = wr * ( 2 - wr ) * wa * ( 2 - wa );
			const pull = ACC.intake * w;
			if ( pull <= 0 ) continue;

			this.inFunnel ++;
			s.wake( i );

			const d = Math.sqrt( d2 );
			const inv = 1 / Math.max( d, 1e-4 );
			const nx = - dx * inv, ny = - dy * inv, nz = - dz * inv;

			// Tangential = axis x offset. This is the spiral, and it is not
			// decoration: tangential speed is angular momentum, and angular
			// momentum is what keeps matter out of the horizon. Holding something
			// at the lip is holding its orbit up.
			let tx = ay * dz - az * dy;
			let ty = az * dx - ax * dz;
			let tz = ax * dy - ay * dx;
			const tl = Math.sqrt( tx * tx + ty * ty + tz * tz );

			if ( tl > 1e-5 ) { tx /= tl; ty /= tl; tz /= tl; } else { tx = 0; ty = 0; tz = 0; }

			const rad = pull * ( 1 - ACC.swirl );
			const tan = pull * ACC.swirl;

			const ux = nx * rad + tx * tan;
			const uy = ny * rad + ty * tan;
			const uz = nz * rad + tz * tan;
			const ul = Math.sqrt( ux * ux + uy * uy + uz * uz ) || 1;

			// §10.2: the loser of any exchange is whoever keeps originating force.
			// Charge full price for accelerating something at rest, nothing for
			// steering something already going where you want it. Read before the
			// write, or this frame's own delta-v shows up as motion you did not
			// have to pay for.
			const vAlong = ( s.vx[ i ] * ux + s.vy[ i ] * uy + s.vz[ i ] * uz ) / ul;
			const theft = 1 - Math.min( 1, Math.max( 0, vAlong / ACC.freeSpeed ) );

			this.watts += s.mass[ i ] * ul * ACC.intakeWattsPerKg * theft;

			s.vx[ i ] += ux * dt;
			s.vy[ i ] += uy * dt;
			s.vz[ i ] += uz * dt;

			// Viscosity, and it is not a polish term — it is what makes the swirl
			// affordable. A central pull plus a tangential one and nothing else
			// conserves angular momentum exactly: matter settles into an orbit at
			// sqrt(a_r · r) and never reaches the horizon. Swept as a pair, the
			// trade is stark — at swirl 0.62 the funnel captures 13% of what enters
			// it with viscosity 3 and 53% with viscosity 13. A real accretion disc
			// falls in because viscosity transports angular momentum outward, so
			// that is what this is: a bleed on the component of velocity
			// perpendicular to the line of sight, scaled by depth in the funnel.
			//
			// Radial speed is deliberately untouched. Everything you spent pulling
			// something toward you is still in it when you let go (§10.2), which is
			// the only reason not to eat everything.
			if ( ACC.viscosity > 0 ) {

				const visc = 1 - Math.exp( - ACC.viscosity * w * dt );
				const vOut = ( s.vx[ i ] * dx + s.vy[ i ] * dy + s.vz[ i ] * dz ) * inv * inv;

				s.vx[ i ] -= ( s.vx[ i ] - vOut * dx ) * visc;
				s.vy[ i ] -= ( s.vy[ i ] - vOut * dy ) * visc;
				s.vz[ i ] -= ( s.vz[ i ] - vOut * dz ) * visc;

			}

			// Gravity is deliberately *not* cancelled. The funnel out-pulls it near
			// the axis and loses to it at the lip, so heavy things sag out of the
			// edge on their own — §8.3's asymmetry rendered as geometry instead of
			// as a number you have to be told.

			// §10.7: anything under the funnel bleeds thermal signature, and the
			// bloom is proportional to what that piece is costing you.
			this.debris.setHeat( i, Math.min( 1, 0.18 + wr * 0.5 + theft * 0.4 ) );

		}

		// --- fire / vent --------------------------------------------------------

		if ( input.fire ) this.fire();
		if ( input.vent ) this.vent();

		// --- running costs ------------------------------------------------------

		this.watts += this.mass * ACC.carryWattsPerKg;

		this.peakWatts = Math.max( this.peakWatts * 0.995, this.watts );
		this.heat += ( this.watts * 0.06 - ACC.ventRate ) * dt;
		this.heat = Math.max( 0, Math.min( ACC.heatCeiling, this.heat ) );

		this.flight.load = this.mass;

	}

	_consume( i ) {

		const s = this.solver;

		// Freshly fired matter is immune, or a shot fired while backing up gets
		// swallowed on the frame it leaves.
		if ( this._clock - this._spawnedAt[ i ] < ACC.rechewDelay ) return false;

		// A chunk still welded into a wall is load-bearing structure. Hoovering it
		// out of the lattice would route around the entire destruction model,
		// which says walls come apart under force, not under suction.
		if ( s.jointDegree( i ) > 0 ) return false;

		const m = s.mass[ i ];
		if ( this.mass + m > ACC.capacity ) { this.stalled = true; return false; }

		const kind = s.material[ i ] % KINDS;
		this.pool[ kind ] += m;
		this.mass += m;
		this.consumed ++;

		if ( this.onConsume ) this.onConsume( kind, m, s.px[ i ], s.py[ i ], s.pz[ i ] );

		s.consume( i );
		return true;

	}

	fire() {

		const s = this.solver;
		const kind = this.selected;
		const available = this.pool[ kind ];
		if ( available <= 0 ) return 0;

		const pm = this.pieceMass( kind );
		const want = Math.min( ACC.fireMass, available );

		// Always at least one piece, so a residue smaller than a single grain can
		// still be spent instead of sitting in the pool forever.
		const n = Math.max( 1, Math.min( ACC.maxBurst, Math.floor( want / pm ) ) );

		_dir.copy( this.axis );
		_right.set( 1, 0, 0 ).applyQuaternion( this.flight.viewQuaternion );
		_up.set( 0, 1, 0 ).applyQuaternion( this.flight.viewQuaternion );

		const origin = this.flight.viewPosition;
		const g = GRAIN[ kind ];
		const share = ACC.fireBudget / n;

		let ix = 0, iy = 0, iz = 0, spawned = 0;

		for ( let p = 0; p < n; p ++ ) {

			// Outside the horizon by construction: the axial offset alone clears
			// it, and the jitter is perpendicular, so it can only add distance.
			const a = ( p / n ) * Math.PI * 2 + this._clock * 3.1;
			const jr = 0.18 + ( p % 3 ) * 0.09;

			_spawn.copy( origin )
				.addScaledVector( _dir, ACC.horizon + 0.42 )
				.addScaledVector( _right, Math.cos( a ) * jr )
				.addScaledVector( _up, Math.sin( a ) * jr );

			const b = s.spawn( _spawn.x, _spawn.y, _spawn.z, g.half, g.half, g.half, g.density, kind );
			if ( b < 0 ) break;

			this._spawnedAt[ b ] = this._clock;
			this.debris.register( b, kind );
			this.debris.setHeat( b, 1 );

			const sx = _dir.x + ( Math.random() - 0.5 ) * ACC.fireSpread;
			const sy = _dir.y + ( Math.random() - 0.5 ) * ACC.fireSpread;
			const sz = _dir.z + ( Math.random() - 0.5 ) * ACC.fireSpread;
			const sl = Math.sqrt( sx * sx + sy * sy + sz * sz ) || 1;

			const m = s.mass[ b ];
			const j = Math.min( m * ACC.fireSpeed, share );

			s.applyImpulse( b, sx / sl * j, sy / sl * j, sz / sl * j );
			s.wx[ b ] += ( Math.random() - 0.5 ) * ACC.fireSpin * 6;
			s.wy[ b ] += ( Math.random() - 0.5 ) * ACC.fireSpin * 6;
			s.wz[ b ] += ( Math.random() - 0.5 ) * ACC.fireSpin * 6;

			ix += sx / sl * j; iy += sy / sl * j; iz += sz / sl * j;

			// Launching from rest is the expensive case, and the economy hangs off
			// exactly that.
			this.watts += j * ACC.intakeWattsPerKg * 20;
			spawned ++;

		}

		if ( spawned === 0 ) return 0;

		const drawn = Math.min( available, spawned * pm );
		this.pool[ kind ] = Math.max( 0, this.pool[ kind ] - drawn );
		this.mass = Math.max( 0, this.mass - drawn );

		this.lastFireSpeed = Math.sqrt( ix * ix + iy * iy + iz * iz ) / FLIGHT.recoilMass;

		// Recoil. Heaving a piano launches you backward (§3.4).
		this.flight.applyImpulse( - ix, - iy, - iz );

		if ( this.onFire ) this.onFire( kind, spawned, this.lastFireSpeed );
		return spawned;

	}

	// Dump the load. Mass is discarded, not spawned — venting is throwing away
	// ammunition, which is what makes saturation a real cost rather than a
	// counter you clear for free.
	vent() {

		if ( this.mass <= 0 ) return 0;
		const dumped = this.mass;
		this.pool.fill( 0 );
		this.mass = 0;
		this.heat = Math.min( ACC.heatCeiling, this.heat + dumped * 0.02 );
		if ( this.onVent ) this.onVent( dumped );
		return dumped;

	}

}
