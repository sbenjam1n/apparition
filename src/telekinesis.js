// Telekinesis, and the held-object orbit that stands in for a body.
//
// §47.3: held objects are the cockpit and they do five jobs at once — frame of
// reference, inventory, cover, self-readout (the count and mass in orbit *is*
// current draw, because holding costs continuous power), and liability (they
// bloom thermally and they block your view). This module is all five.
//
// The cost model is §8.3: watts scale with mass x acceleration. Accelerating from
// rest is expensive, nudging something already moving is nearly free. That
// asymmetry is the whole of momentum theft (§10.2) and it is the one number in
// here that should not be tuned for comfort.

import * as THREE from 'three';
import { TUNING as FLIGHT } from './flight.js';

export const TK = {
	reachRadius: 7.5,        // how far you can acquire
	orbitBase: 1.15,         // orbit radius with one object held
	orbitPerItem: 0.16,      // §47.4: reach grows, the orbit widens, the body dissolves
	maxHeld: 12,
	servoStiffness: 16.0,    // how hard held mass is pulled to its slot
	servoDamping: 0.82,
	maxServoSpeed: 26.0,
	holdWattsPerKg: 0.12,    // continuous cost of simply keeping it up
	accelWattsPerKg: 0.08,   // §8.3 — the expensive half
	throwSpeed: 16.0,        // m/s a light object leaves at
	// A fixed impulse budget per throw, shared across whatever is in orbit. This
	// one number is the difference between a toy and the design: a 10kg paver
	// takes the full speed and shoves you 2.5m/s, while a 430kg bench eats the
	// entire budget, barely moves, and launches *you* at 13m/s. Heaving a piano
	// launches you backward (§3.4), and heavy things go slow because watts scale
	// with mass x acceleration (§8.3) — both fall out of the same cap.
	throwBudget: 900,        // N·s
	throwSpin: 1.4,
	ventRate: 3.4,           // watts shed per second when spending nothing
	heatCeiling: 100,
	wattScale: 600           // full-scale for the draw readout and bloom coupling
};

const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _target = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

export class Telekinesis {

	constructor( solver, flight, debris ) {

		this.solver = solver;
		this.flight = flight;
		this.debris = debris;

		this.held = [];          // body indices
		this.watts = 0;          // instantaneous draw
		this.heat = 0;           // accumulated thermal debt (§5.3)
		this.peakWatts = 0;
		this.probeTarget = - 1;
		this.probeInfo = null;
		this.lastThrowSpeed = 0;

		this.onGrab = null;
		this.onThrow = null;
		this.onProbe = null;

		this._phase = 0;

	}

	get load() {

		let m = 0;
		for ( let i = 0; i < this.held.length; i ++ ) m += this.solver.mass[ this.held[ i ] ];
		return m;

	}

	// Nearest body whose bounding sphere the view ray pierces. Cheap and good
	// enough — precision here would only make grabbing feel fussy.
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

		_dir.set( 0, 0, - 1 ).applyQuaternion( f.viewQuaternion ).normalize();
		_right.set( 1, 0, 0 ).applyQuaternion( f.viewQuaternion );
		_up.set( 0, 1, 0 ).applyQuaternion( f.viewQuaternion );

		const origin = f.viewPosition;
		this.watts = 0;

		// --- probe ----------------------------------------------------------
		// Cheap sensing pulse: reveals material response, structural weakness and
		// thermal state (§3.2). It is also how a weak wall is confirmed (§7.2).

		this.probeTarget = this.pick( origin, _dir, TK.reachRadius * 1.6 );
		this.probeInfo = null;

		const panel = destruction ? destruction.probe( origin, _dir, TK.reachRadius * 2.2 ) : null;

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

		// --- acquire --------------------------------------------------------

		if ( input.grab && this.held.length < TK.maxHeld ) {

			const i = this.probeTarget;

			if ( i >= 0 && this.held.indexOf( i ) === - 1 ) {

				this.held.push( i );
				s.wake( i );
				if ( this.onGrab ) this.onGrab( i );

			}

		}

		if ( input.releaseOrbit ) this.releaseAll();

		// --- hold -----------------------------------------------------------

		this._phase += dt * 0.55;

		const radius = TK.orbitBase + this.held.length * TK.orbitPerItem;

		for ( let k = this.held.length - 1; k >= 0; k -- ) {

			const i = this.held[ k ];

			if ( s.state[ i ] === 0 ) { this.held.splice( k, 1 ); continue; }

			s.wake( i );

			// Slot: an even ring in front of and around the viewpoint, tilted so
			// the orbit does not sit flat and occlude the centre of the frame.
			const a = this._phase + ( k / Math.max( 1, this.held.length ) ) * Math.PI * 2;
			const tilt = Math.sin( a * 1.7 ) * 0.34;

			_target.copy( origin )
				.addScaledVector( _dir, 1.05 + Math.cos( a ) * 0.22 )
				.addScaledVector( _right, Math.cos( a ) * radius )
				.addScaledVector( _up, Math.sin( a ) * radius * 0.62 + tilt );

			const dx = _target.x - s.px[ i ];
			const dy = _target.y - s.py[ i ];
			const dz = _target.z - s.pz[ i ];

			// Velocity servo rather than a position write, so held mass still
			// collides — you can and should shove a held cabinet into a wall.
			let vx = dx * TK.servoStiffness;
			let vy = dy * TK.servoStiffness;
			let vz = dz * TK.servoStiffness;

			const sp = Math.hypot( vx, vy, vz );

			if ( sp > TK.maxServoSpeed ) {

				const q = TK.maxServoSpeed / sp;
				vx *= q; vy *= q; vz *= q;

			}

			vx = s.vx[ i ] * ( 1 - TK.servoDamping ) + vx * TK.servoDamping;
			vy = s.vy[ i ] * ( 1 - TK.servoDamping ) + vy * TK.servoDamping;
			vz = s.vz[ i ] * ( 1 - TK.servoDamping ) + vz * TK.servoDamping;

			// §8.3: the bill is mass x acceleration, plus a standing charge for
			// not letting go. Matching an object's existing motion is nearly free.
			const ax = ( vx - s.vx[ i ] ) / dt;
			const ay = ( vy - s.vy[ i ] ) / dt;
			const az = ( vz - s.vz[ i ] ) / dt;
			const accel = Math.hypot( ax, ay, az );
			const m = s.mass[ i ];

			this.watts += m * ( TK.holdWattsPerKg + accel * TK.accelWattsPerKg );

			s.vx[ i ] = vx; s.vy[ i ] = vy; s.vz[ i ] = vz;

			// Cancel gravity on held mass — the solver re-applies it every step
			// and without this the orbit sags visibly under anything heavy.
			s.vy[ i ] -= s.gravity * dt;

			// Slow tumble so held objects read as suspended rather than frozen.
			s.wx[ i ] *= 0.94; s.wy[ i ] *= 0.94; s.wz[ i ] *= 0.94;
			s.wx[ i ] += ( Math.sin( a * 2.3 ) ) * 0.06;
			s.wz[ i ] += ( Math.cos( a * 1.9 ) ) * 0.06;

			// §10.7: anything under active telekinesis bleeds thermal signature.
			// The bloom is proportional to what you are spending on that object,
			// so an expensive grab is a bright grab.
			this.debris.setHeat( i, Math.min( 1.0, 0.22 + accel * 0.012 + m * 0.02 ) );

		}

		// --- throw ----------------------------------------------------------

		if ( input.throw && this.held.length > 0 ) this._throw();

		// --- thermal --------------------------------------------------------

		this.peakWatts = Math.max( this.peakWatts * 0.995, this.watts );
		this.heat += ( this.watts * 0.06 - TK.ventRate ) * dt;
		this.heat = Math.max( 0, Math.min( TK.heatCeiling, this.heat ) );

		this.flight.load = this.load;

	}

	_throw() {

		const s = this.solver;
		let ix = 0, iy = 0, iz = 0;

		_dir.set( 0, 0, - 1 ).applyQuaternion( this.flight.viewQuaternion ).normalize();

		const share = TK.throwBudget / this.held.length;

		for ( let k = 0; k < this.held.length; k ++ ) {

			const i = this.held[ k ];
			const m = s.mass[ i ];
			const j = Math.min( m * TK.throwSpeed, share );

			s.applyImpulse( i, _dir.x * j, _dir.y * j, _dir.z * j );
			s.wx[ i ] += ( Math.random() - 0.5 ) * TK.throwSpin * 6;
			s.wy[ i ] += ( Math.random() - 0.5 ) * TK.throwSpin * 6;
			s.wz[ i ] += ( Math.random() - 0.5 ) * TK.throwSpin * 6;

			this.debris.setHeat( i, 1.0 );

			ix += _dir.x * j; iy += _dir.y * j; iz += _dir.z * j;

			// Launching from rest is the expensive case, and the whole economy
			// hangs off that (§10.2: the loser of any exchange is whoever keeps
			// originating force).
			this.watts += j * TK.accelWattsPerKg * 20;

		}

		this.lastThrowSpeed = Math.hypot( ix, iy, iz ) / FLIGHT.recoilMass;

		// Recoil. Heaving a piano launches you backward (§3.4).
		this.flight.applyImpulse( - ix, - iy, - iz );

		if ( this.onThrow ) this.onThrow( this.held.length, this.lastThrowSpeed );
		this.held.length = 0;

	}

	releaseAll() {

		const s = this.solver;

		for ( let k = 0; k < this.held.length; k ++ ) {

			const i = this.held[ k ];
			if ( s.state[ i ] !== 0 ) s.restTimer[ i ] = 0;

		}

		this.held.length = 0;

	}

}
