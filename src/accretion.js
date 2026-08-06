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
	// Reach and intake were 7.5m and 90 m/s², and both were too small to read as
	// force. A bench took three seconds to peel off the floor, which is a machine
	// working, not a thing being taken. Longer and much harder: opening the funnel
	// should make the far side of the room start moving, and the extra length is
	// what keeps the release window open now that everything arrives faster.
	reach: 11.0,             // how far down the axis the mouth extends
	mouthAngle: 0.62,        // half-angle of the cone, radians (~35°)
	horizon: 0.95,           // consumed inside this radius, always live
	intake: 220.0,           // m/s² of pull on the axis at the apex
	// Newton's third law on the pull. §3.4 already governs the recoil of a throw
	// and there is no reason the intake should be exempt: hauling on 400kg of
	// bench hauls back, and that reaction is most of what separates a force from
	// a field. Clamped rather than scaled, because the raw reaction to the near
	// field is several hundred m/s² and would fire the player across the room.
	reaction: 1.0,           // 0 disables; 1 is the full clamped reaction
	reactionCeiling: 1100,   // N, the most the funnel can ever pull back with
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
	// Rescaled with the pull. At 0.08 against a 220 m/s² intake the meter
	// pegged the moment the funnel touched anything heavy, which makes it a
	// light rather than a curve — and the whole reason the draw readout is in
	// this build is that a feel test that cannot show its cost curve cannot be
	// tuned. The shape of §8.3 is unchanged; only the constant moved.
	intakeWattsPerKg: 0.035, // §8.3, the expensive half

	// --- channelling --------------------------------------------------------
	// Firing used to spawn one to eight rigid boxes, which is a brick-throwing
	// simulator no matter how fast the bricks go. It is now a continuous stream of
	// shards (shred.js), held rather than clicked, because the thing being asked
	// for is a jet and a jet is a rate, not an event.
	//
	// The split follows the wind-engineering classification: compact debris flies
	// ballistically and needs a rigid body, plate debris goes where the air goes
	// and does not. Everything the funnel channels is plate debris.
	fireSpeed: 62.0,         // m/s at the muzzle; light pieces need speed to carry
	// 46 kg/s emptied a full disc in twenty seconds and, worse, produced 2850N
	// of continuous thrust — one second on the trigger put the player at 40 m/s,
	// which is a rocket rather than a weapon. A mass flow really does push back
	// that hard; the fix is to channel less of it, not to pretend otherwise.
	channelRate: 16.0,       // kg/s drawn from the pool while held
	channelSpread: 0.20,     // half-angle of the jet cone, radians
	// The stream corkscrews rather than flying straight, and this is not only a
	// look. A velocity-aligned streak fired directly along the view axis is seen
	// end-on and projects to a dot: the jet measured at eleven hundred shards a
	// second and rendered as an almost empty room. Tangential motion gives every
	// shard a cross-axis component, so it reads as a streak from behind it as well
	// as from the side — and a rotating jet is what an accretion disc throws
	// anyway, so the fix and the reference are the same thing.
	jetSwirl: 0.13,          // tangential speed as a fraction of muzzle speed
	jetTwist: 34.0,          // rad/s the emitter turns; this is the visible helix
	streamDensity: 1.0,      // global multiplier on shard count; grain sets the rest
	jetSpin: 1.4,
	rechewDelay: 0.35,       // s of immunity so fired matter is not re-eaten

	// --- the disc -----------------------------------------------------------
	// What you are carrying, made visible as the thing the reference image was:
	// matter in orbit, not a number on a readout. Bound shards are non-physical
	// and cost one draw call shared with everything else in shred.js.
	// Pushed out in front of the apex rather than centred on it. Orbiting *at* the
	// viewpoint puts the whole ring at ninety degrees off-axis, which is outside
	// any sane field of view — the disc was running correctly and drawing nothing.
	// Ahead by this much, a ring of this radius lands just inside the frame edge,
	// which is where it was asked to be: fullness at the periphery, like mud on
	// the lens.
	discOffset: 2.3,
	discRadius: 1.5,         // at full capacity
	discThickness: 0.55,
	discSpin: 5.2,           // rad/s
	discShards: 620,         // population at full capacity

	// --- readout ------------------------------------------------------------
	ventRate: 3.4,
	heatCeiling: 100,
	wattScale: 1000

};

// What each material becomes when it is torn up. The four numbers are the only
// place the materials mean anything mechanically, and they are now about *grain*
// rather than about lumps: `shard` is the mass of one piece of the stream, and
// `size` is how big it draws.
//
// This is the Tachikawa split, which is the parameter wind engineering uses to
// rate whether debris flies at all — aerodynamic force over weight, so area per
// unit mass. Glass tears into a lot of very light needles with an enormous ratio
// and it hangs in the air; steel tears into few dense grains that punch through
// and drop. Same kilogram of pool, completely different weapon.
const GRAIN = [
	{ shard: 0.055, size: 1.00, drag: 1.00 },   // tile     — grit
	{ shard: 0.110, size: 1.35, drag: 0.80 },   // concrete — coarse rubble
	{ shard: 0.014, size: 0.72, drag: 1.75 },   // glass    — needles, and a lot of them
	{ shard: 0.190, size: 0.62, drag: 0.55 }    // steel    — dense, small, and it carries
];

export const MATERIAL_NAME = [ 'tile', 'concrete', 'glass', 'steel' ];

const KINDS = 4;

const _look = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _spawn = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

// The orbit descriptor handed to shred.js each frame. A plain object rather than
// a class: it is written once per frame and read by a few thousand shards.
const _disc = {
	x: 0, y: 0, z: 0,
	dx: 0, dy: 0, dz: - 1,
	rx: 1, ry: 0, rz: 0,
	ux: 0, uy: 1, uz: 0,
	radius: 1, thickness: 0.5, spin: 5
};

export class Accretion {

	constructor( solver, flight, debris, shred ) {

		this.solver = solver;
		this.flight = flight;
		this.debris = debris;
		this.shred = shred;

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
		this.reactionN = 0;         // newtons the funnel is pulling back with
		this.channelling = false;
		this.jetRate = 0;           // shards/s currently leaving
		this._shardDebt = 0;        // fractional shards carried between frames
		this._boundWant = 0;

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

	shardMass( kind ) {

		return GRAIN[ kind ].shard;

	}

	// The heaviest thing in the pool, which is what the stream fires unless you
	// have chosen otherwise. Keeps the selector from being mandatory.
	heaviest() {

		let best = this.selected, bestKg = this.pool[ this.selected ];
		for ( let k = 0; k < KINDS; k ++ ) if ( this.pool[ k ] > bestKg ) { bestKg = this.pool[ k ]; best = k; }
		return best;

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

		// Reaction accumulator. Summed over everything the funnel touches and
		// applied once, so the clamp is on the total rather than per body — a
		// hundred shards should not out-pull one bench.
		let rfx = 0, rfy = 0, rfz = 0;

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

			// Third law. The force the funnel puts into this body is force it is
			// also putting into you, and mass enters here even though it does not
			// enter the acceleration — which is the point. A shard is nothing to
			// haul on; a 430kg bench hauls back hard enough to move you.
			const fm = s.mass[ i ];
			rfx -= ux * fm; rfy -= uy * fm; rfz -= uz * fm;

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

		// Apply the accumulated reaction, clamped as a whole. Near the apex the
		// raw figure runs to tens of kN and would fire the player across the room;
		// the ceiling is what keeps this a lean rather than a launch, and it is a
		// slider because it is the one number that decides whether the funnel is
		// also a movement tool.
		if ( ACC.reaction > 0 ) {

			const rf = Math.sqrt( rfx * rfx + rfy * rfy + rfz * rfz );

			if ( rf > 1e-3 ) {

				const q = ACC.reaction * Math.min( rf, ACC.reactionCeiling ) / rf * dt;
				this.flight.applyImpulse( rfx * q, rfy * q, rfz * q );

			}

			this.reactionN = rf;

		} else this.reactionN = 0;

		// --- fire / vent --------------------------------------------------------

		this.channelling = !! input.fire && this.mass > 0;
		if ( this.channelling ) this.channel( dt ); else this.jetRate = 0;
		if ( input.vent ) this.vent();

		this._syncDisc( dt );

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

		// It comes apart. Deleting the body and adding a number to a pool is what
		// made this read as swallowing rather than shredding — the burst is the
		// same body, in pieces, still carrying the velocity it arrived with, and
		// those pieces then spiral in like everything else in the funnel.
		this.shred.burst( s.px[ i ], s.py[ i ], s.pz[ i ],
			s.vx[ i ] * 0.45, s.vy[ i ] * 0.45, s.vz[ i ] * 0.45,
			m, kind, Math.max( 0.12, s.radius[ i ] * 0.7 ) );

		if ( this.onConsume ) this.onConsume( kind, m, s.px[ i ], s.py[ i ], s.pz[ i ] );

		s.consume( i );
		return true;

	}

	// The channel. Held rather than clicked, and a rate rather than an event: the
	// pool drains at channelRate while the trigger is down and comes out as a
	// stream of shards along the axis.
	//
	// Nothing spawned here is a rigid body. That is the point — a jet made of
	// solver bodies would be a few dozen boxes and would cost the contact graph
	// for every one, where this is a few hundred shards a second against a plane
	// test each. It is also the correct physics: this is plate debris, and plate
	// debris goes where the flow goes rather than following its own ballistic arc.
	channel( dt ) {

		const kind = this.pool[ this.selected ] > 0 ? this.selected : this.heaviest();
		const available = this.pool[ kind ];
		if ( available <= 0 || dt <= 0 ) { this.jetRate = 0; return 0; }

		const g = GRAIN[ kind ];
		const drawn = Math.min( available, ACC.channelRate * dt );

		// Piece count comes from the *grain*, not from a global rate, and that is
		// the whole material difference. The same 16 kg/s leaves as eleven hundred
		// glass needles a second or as eighty-four steel grains — identical mass
		// flow, identical recoil, and completely different weapons, because what
		// changes is the energy per hit rather than the energy. Sandblasting
		// versus punching.
		this._shardDebt += drawn / g.shard * ACC.streamDensity;
		const n = Math.floor( this._shardDebt );
		this._shardDebt -= n;

		_dir.copy( this.axis );
		_right.set( 1, 0, 0 ).applyQuaternion( this.flight.viewQuaternion );
		_up.set( 0, 1, 0 ).applyQuaternion( this.flight.viewQuaternion );

		const o = this.flight.viewPosition;

		if ( n > 0 ) {

			this.shred.jet(
				o.x, o.y, o.z,
				_dir.x, _dir.y, _dir.z,
				_right.x, _right.y, _right.z,
				_up.x, _up.y, _up.z,
				n, kind, ACC.fireSpeed, ACC.channelSpread,
				drawn / n, g.size, g.drag, ACC.jetSwirl, this._clock * ACC.jetTwist );

			// What leaves the disc has to visibly leave the disc, or the orbit is
			// a decal that never spends.
			this.shred.releaseBound( Math.min( n, 8 ), _dir.x, _dir.y, _dir.z, ACC.fireSpeed * 0.8 );

		}

		this.pool[ kind ] = Math.max( 0, this.pool[ kind ] - drawn );
		this.mass = Math.max( 0, this.mass - drawn );

		// Recoil is now a continuous thrust rather than a kick, which is what a
		// mass flow actually produces (§3.4). Holding the trigger is a burn.
		const thrust = drawn * ACC.fireSpeed;
		this.flight.applyImpulse( - _dir.x * thrust, - _dir.y * thrust, - _dir.z * thrust );
		this.lastFireSpeed = thrust / ( FLIGHT.recoilMass * Math.max( dt, 1e-4 ) );

		this.watts += drawn / Math.max( dt, 1e-4 ) * ACC.fireSpeed * ACC.intakeWattsPerKg * 1.6;
		this.jetRate = n / Math.max( dt, 1e-4 );

		if ( this.onFire ) this.onFire( kind, n, drawn );
		return n;

	}

	// Keep the visible disc population in step with what is actually carried, a
	// few shards a frame rather than all at once — the disc should fill as you
	// eat and thin as you spend, not pop between states.
	_syncDisc( dt ) {

		const sat = Math.min( 1, this.saturation );
		const want = Math.round( sat * ACC.discShards );
		const have = this.shred.boundCount();

		if ( want > have ) {

			const kind = this.heaviest();
			this.shred.bind( Math.min( 14, want - have ), kind, GRAIN[ kind ].size );

		} else if ( have > want + 8 ) {

			// Excess falls out rather than being deleted, so a disc that has just
			// been spent sheds visibly.
			this.shred.releaseBound( Math.min( 10, have - want ), _dir.x, _dir.y, _dir.z, 3.5 );

		}

		_disc.dx = this.axis.x; _disc.dy = this.axis.y; _disc.dz = this.axis.z;
		_disc.x = this.flight.viewPosition.x + _disc.dx * ACC.discOffset;
		_disc.y = this.flight.viewPosition.y + _disc.dy * ACC.discOffset;
		_disc.z = this.flight.viewPosition.z + _disc.dz * ACC.discOffset;

		// A stable basis perpendicular to the axis. Branch-free pick of the least
		// aligned world axis, so the disc does not spin up when you look straight
		// down (Duff et al., same trick the solver uses for contact tangents).
		const ax = Math.abs( _disc.dx ), ay = Math.abs( _disc.dy );
		const sx = ax < ay && ax < Math.abs( _disc.dz ) ? 1 : 0;
		const sy = sx === 0 && ay <= Math.abs( _disc.dz ) ? 1 : 0;
		const sz = sx === 0 && sy === 0 ? 1 : 0;

		let rx = _disc.dy * sz - _disc.dz * sy;
		let ry = _disc.dz * sx - _disc.dx * sz;
		let rz = _disc.dx * sy - _disc.dy * sx;
		const rl = Math.sqrt( rx * rx + ry * ry + rz * rz ) || 1;
		rx /= rl; ry /= rl; rz /= rl;

		_disc.rx = rx; _disc.ry = ry; _disc.rz = rz;
		_disc.ux = _disc.dy * rz - _disc.dz * ry;
		_disc.uy = _disc.dz * rx - _disc.dx * rz;
		_disc.uz = _disc.dx * ry - _disc.dy * rx;

		_disc.radius = ACC.discRadius * ( 0.45 + sat * 0.55 );
		_disc.thickness = ACC.discThickness;
		_disc.spin = ACC.discSpin;

		return _disc;

	}

	get disc() {

		return _disc;

	}

	// Dump the load. Mass is discarded, not spawned — venting is throwing away
	// ammunition, which is what makes saturation a real cost rather than a
	// counter you clear for free.
	vent() {

		if ( this.mass <= 0 ) return 0;
		const dumped = this.mass;
		// The disc empties where you are standing, so venting is visibly throwing
		// something away rather than a counter resetting.
		this.shred.releaseBound( 999, this.axis.x, this.axis.y, this.axis.z, 4.5 );
		this.pool.fill( 0 );
		this.mass = 0;
		this.heat = Math.min( ACC.heatCeiling, this.heat + dumped * 0.02 );
		if ( this.onVent ) this.onVent( dumped );
		return dumped;

	}

}
