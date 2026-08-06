// 6DOF flight.
//
// The model is Descent's, kept deliberately intact: fixed 1/64s substeps, a
// single drag coefficient applied to both linear and angular velocity, thrust as
// a per-substep delta-v rather than an acceleration, sinusoidal wiggle, and
// turn-induced banking. Those five things together are what the feel actually is
// — every attempt to "improve" one of them in isolation makes it worse.
//
// Constants come from the PLAYER_SHIP entry in Descent's bitmaps.bin, by way of
// mrdoob's three.js port (MIT): https://github.com/mrdoob/three-descent
//
// Every tuning number below is three-descent's, unscaled — thrust, drag, mouse
// sensitivity, roll scale. The room is 28m end to end and Descent's terminal
// velocity is ~57 u/s, so it crosses in about half a second. That is the real
// Descent feel and it is deliberately the default; `thrust` in the tuning panel
// is the one dial to turn if you want the room to read as larger.
//
// One thing is ours rather than Descent's: the camera is not the player. It
// trails the player's transform on a spring, and the spring gets heavier as you
// carry more. A viewpoint that lags input has mass, and mass reads as embodiment
// (§47.2) — which is the only body this character is ever going to get.

import * as THREE from 'three';

export const TUNING = {
	// Descent's PLAYER_SHIP mass is a coefficient in Descent's own units, not a
	// weight — it only ever appears as thrust/mass. Recoil needs a real inertia
	// in kilograms, and conflating the two makes a thrown paver launch you across
	// the room at 40m/s. They are deliberately separate numbers.
	mass: 4.0,
	recoilMass: 70,
	drag: 0.033,
	maxThrust: 7.8,
	maxRotThrust: 0.14,
	wiggle: 0.5,
	substep: 1 / 64,
	radius: 0.34,

	// Descent's own numbers, verbatim. thrustScale 1.0 means PLAYER_MAX_THRUST is
	// applied unscaled, which gives Descent's real terminal velocity of ~57 u/s:
	//     v = (v + thrust/mass) * (1 - drag)  ->  v = 1.95 * 0.967 / 0.033
	// This room is 28m end to end, so that is about half a second corner to
	// corner. Dial `thrust` down if you want the room to feel larger; 0.145 was
	// the previous value and reads at roughly walking-a-building pace.
	thrustScale: 1.0,
	burnMultiplier: 1.9,
	// Both of these are three-descent's values. mouseSensitivity in particular was
	// 0.9 here against three-descent's 0.02 — 45x too sensitive, which is the
	// entire reason rotation felt wrong.
	rollThrustScale: 1.6,
	// Keyboard pitch/yaw at full rated rotational thrust — terminal ~59 deg/s,
	// which is a turn you can hold and stop on a mark.
	keyRotScale: 1.0,
	mouseSensitivity: 0.02,
	invertY: false,

	cameraLag: 0.045,        // seconds of positional trail at zero load
	cameraLagPerKg: 0.00008,
	cameraLagMax: 0.16,
	rotationLag: 0.035,
	swayAmount: 0.6,

	autoLevel: true,
	autoLevelRate: 0.9
};

const FIXANG = Math.PI * 2 / 65536;
const TURNROLL_SCALE = 0.154;
const ROLL_RATE = 0x2000 * FIXANG;
const DAMP_ANG = 0x400 * FIXANG;

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _thrust = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class Flight {

	constructor( solver ) {

		this.solver = solver;

		this.position = new THREE.Vector3( 0, 1.7, 10.5 );
		this.quaternion = new THREE.Quaternion();
		this.velocity = new THREE.Vector3();
		this.rotVelocity = new THREE.Vector3();   // pitch, yaw, roll — body axes, rad/s
		this.turnroll = 0;

		// What the camera actually uses.
		this.viewPosition = this.position.clone();
		this.viewQuaternion = this.quaternion.clone();
		this._viewVel = new THREE.Vector3();

		this.load = 0;            // kg currently held, drives camera lag
		this.lastImpact = 0;      // speed of the most recent wall hit, for audio
		this.grounded = false;

		// Weak panels block the player cell by cell, so a hole you made is a hole
		// you can fly through and nothing else is. §31.3's aperture question
		// becomes a physical fact rather than a reported one.
		this.panels = [];

		// Facing -Z on spawn: down the hall, into the haze and the piers, with the
		// pool behind your shoulder. You should have to turn round to find it.
		this.quaternion.identity();
		this.viewQuaternion.copy( this.quaternion );

	}

	reset() {

		this.position.set( 0, 1.7, 10.5 );
		// Facing -Z on spawn: down the hall, into the haze and the piers, with the
		// pool behind your shoulder. You should have to turn round to find it.
		this.quaternion.identity();
		this.velocity.set( 0, 0, 0 );
		this.rotVelocity.set( 0, 0, 0 );
		this.turnroll = 0;
		this.viewPosition.copy( this.position );
		this.viewQuaternion.copy( this.quaternion );

	}

	basis() {

		_fwd.set( 0, 0, - 1 ).applyQuaternion( this.quaternion );
		_right.set( 1, 0, 0 ).applyQuaternion( this.quaternion );
		_up.set( 0, 1, 0 ).applyQuaternion( this.quaternion );

	}

	// Recoil. Newton applies, and throwing is a movement system as much as an
	// attack system (§3.4).
	applyImpulse( x, y, z ) {

		const inv = 1 / TUNING.recoilMass;
		this.velocity.x += x * inv;
		this.velocity.y += y * inv;
		this.velocity.z += z * inv;

	}

	update( input, dt ) {

		const T = TUNING;
		this.basis();

		// --- rotation -------------------------------------------------------

		const rotThrust = this._readRotation( input );
		this._substepRotation( rotThrust, dt );

		// Body-axis integration: pitch about local X, yaw about local Y, roll
		// about local Z, applied in that order so yaw does not tilt the horizon.
		const rv = this.rotVelocity;
		this._rotateLocal( 1, 0, 0, rv.x * dt );
		this._rotateLocal( 0, 1, 0, rv.y * dt );
		this._rotateLocal( 0, 0, 1, rv.z * dt );

		this._turnroll( dt );
		if ( T.autoLevel ) this._autoLevel( dt );

		this.basis();

		// --- translation ----------------------------------------------------

		const scale = T.maxThrust * T.thrustScale * ( input.burn ? T.burnMultiplier : 1 );
		_thrust.set( 0, 0, 0 );

		if ( input.forward ) _thrust.addScaledVector( _fwd, scale );
		if ( input.back ) _thrust.addScaledVector( _fwd, - scale );
		if ( input.right ) _thrust.addScaledVector( _right, scale );
		if ( input.left ) _thrust.addScaledVector( _right, - scale );
		if ( input.up ) _thrust.addScaledVector( _up, scale );
		if ( input.down ) _thrust.addScaledVector( _up, - scale );

		this._substepLinear( _thrust, dt );

		// Collision is a discrete push-out, not a sweep, so at Descent's real
		// terminal velocity one frame carries you nearly a metre and the thinner
		// static boxes get tunnelled. Subdivide the move instead — it is only a
		// handful of plane tests per step.
		const travel = this.velocity.length() * dt;
		const k = Math.min( 8, Math.max( 1, Math.ceil( travel / 0.15 ) ) );
		const h = dt / k;

		for ( let n = 0; n < k; n ++ ) {

			_tmp.copy( this.velocity ).multiplyScalar( h );
			this.position.add( _tmp );
			this._resolveCollisions();

		}

		this._updateView( dt, input );

		return this.velocity.length();

	}

	_readRotation( input ) {

		const T = TUNING;
		const base = T.maxRotThrust;

		// Mouse delta is a rotational *thrust*, not a rotation. It goes through
		// the same drag as everything else, which is why the look has weight.
		let mx = - input.mouseX * T.mouseSensitivity * base * 3.2;
		let my = ( T.invertY ? 1 : - 1 ) * input.mouseY * T.mouseSensitivity * base * 3.2;

		// Arrows add to the same rotational thrust the mouse feeds, so they go
		// through the same drag and the two can be used together.
		const kr = base * T.keyRotScale;
		const sign = T.invertY ? - 1 : 1;
		if ( input.pitchUp ) my += kr * sign;
		if ( input.pitchDown ) my -= kr * sign;
		if ( input.yawLeft ) mx += kr;
		if ( input.yawRight ) mx -= kr;

		let rz = 0;
		if ( input.rollLeft ) rz += base * T.rollThrustScale;
		if ( input.rollRight ) rz -= base * T.rollThrustScale;

		return { x: my, y: mx, z: rz };

	}

	_substepRotation( rt, dt ) {

		const T = TUNING;
		const ax = rt.x / T.mass, ay = rt.y / T.mass, az = rt.z / T.mass;
		const rv = this.rotVelocity;

		let count = Math.floor( dt / T.substep );
		const k = ( dt - count * T.substep ) / T.substep;
		const scale = 1 - T.drag;

		// Guard against a tab that was backgrounded for ten seconds.
		if ( count > 12 ) count = 12;

		while ( count -- > 0 ) {

			rv.x += ax; rv.y += ay; rv.z += az;
			rv.x *= scale; rv.y *= scale; rv.z *= scale;

		}

		rv.x += ax * k; rv.y += ay * k; rv.z += az * k;
		const ks = 1 - k * T.drag;
		rv.x *= ks; rv.y *= ks; rv.z *= ks;

	}

	_substepLinear( thrust, dt ) {

		const T = TUNING;

		// Wiggle: the ship never sits perfectly still. Costs nothing, and its
		// absence is the single most common reason a 6DOF prototype feels dead.
		const s = Math.sin( performance.now() * 0.001 * Math.PI * 2 ) * T.wiggle * T.thrustScale;
		this.velocity.addScaledVector( _up, s * dt );

		const ax = thrust.x / T.mass, ay = thrust.y / T.mass, az = thrust.z / T.mass;
		const v = this.velocity;

		let count = Math.floor( dt / T.substep );
		const k = ( dt - count * T.substep ) / T.substep;
		const scale = 1 - T.drag;

		if ( count > 12 ) count = 12;

		while ( count -- > 0 ) {

			v.x += ax; v.y += ay; v.z += az;
			v.x *= scale; v.y *= scale; v.z *= scale;

		}

		v.x += ax * k; v.y += ay * k; v.z += az * k;
		const ks = 1 - k * T.drag;
		v.x *= ks; v.y *= ks; v.z *= ks;

	}

	_rotateLocal( x, y, z, angle ) {

		if ( angle === 0 ) return;
		_q.setFromAxisAngle( _tmp.set( x, y, z ), angle );
		this.quaternion.multiply( _q ).normalize();

	}

	// Visual bank into a yaw. Not physical — it is a readability cue that tells
	// you which way you are turning when there is no horizon to check against.
	_turnroll( dt ) {

		const desired = this.rotVelocity.y * TURNROLL_SCALE;

		if ( this.turnroll !== desired ) {

			let maxRoll = ROLL_RATE * dt;
			const delta = desired - this.turnroll;

			if ( Math.abs( delta ) < maxRoll ) maxRoll = delta;
			else if ( delta < 0 ) maxRoll = - maxRoll;

			this.turnroll += maxRoll;

		}

	}

	// Surface anchoring, softened (§3.3). Descent aligned to the nearest segment
	// side normal; with no segments we align to world up, but only when the nose
	// is not pointing near-vertically, and only above a dead band — so it never
	// fights a deliberate barrel roll.
	_autoLevel( dt ) {

		_up.set( 0, 1, 0 ).applyQuaternion( this.quaternion );
		_fwd.set( 0, 0, - 1 ).applyQuaternion( this.quaternion );

		if ( Math.abs( _fwd.y ) >= 0.5 ) return;

		// Project world up and current up into the plane normal to forward.
		const dotWF = _fwd.y;
		const px = - dotWF * _fwd.x, py = 1 - dotWF * _fwd.y, pz = - dotWF * _fwd.z;
		const pm = Math.hypot( px, py, pz );
		if ( pm < 1e-3 ) return;

		const dotUF = _up.dot( _fwd );
		const cx = _up.x - dotUF * _fwd.x, cy = _up.y - dotUF * _fwd.y, cz = _up.z - dotUF * _fwd.z;
		const cm = Math.hypot( cx, cy, cz );
		if ( cm < 1e-3 ) return;

		const nx = px / pm, ny = py / pm, nz = pz / pm;
		const ux = cx / cm, uy = cy / cm, uz = cz / cm;

		const dot = Math.max( - 1, Math.min( 1, ux * nx + uy * ny + uz * nz ) );
		const crossF = ( uy * nz - uz * ny ) * _fwd.x + ( uz * nx - ux * nz ) * _fwd.y + ( ux * ny - uy * nx ) * _fwd.z;
		const delta = Math.atan2( crossF, dot ) + this.turnroll;

		if ( Math.abs( delta ) <= DAMP_ANG ) return;

		let roll = ROLL_RATE * dt * TUNING.autoLevelRate;
		if ( Math.abs( delta ) < roll ) roll = delta;
		else if ( delta < 0 ) roll = - roll;

		this._rotateLocal( 0, 0, 1, roll );

	}

	// Discrete push-out against the same colliders the debris solver uses, then
	// remove the velocity component into the surface. At these speeds a swept
	// test buys nothing a 4-iteration relaxation does not.
	_resolveCollisions() {

		const s = this.solver;
		const r = TUNING.radius;
		this.grounded = false;

		for ( let iter = 0; iter < 4; iter ++ ) {

			let deepest = 0, nx = 0, ny = 0, nz = 0;

			for ( const p of s.planes ) {

				const d = this.position.x * p.nx + this.position.y * p.ny + this.position.z * p.nz - p.d - r;
				if ( d < deepest ) { deepest = d; nx = p.nx; ny = p.ny; nz = p.nz; }

			}

			for ( const b of s.boxes ) {

				const dx = this.position.x - b.cx, dy = this.position.y - b.cy, dz = this.position.z - b.cz;
				const ox = b.hx + r - Math.abs( dx );
				const oy = b.hy + r - Math.abs( dy );
				const oz = b.hz + r - Math.abs( dz );
				if ( ox <= 0 || oy <= 0 || oz <= 0 ) continue;

				let d, ax = 0, ay = 0, az = 0;

				if ( ox <= oy && ox <= oz ) { ax = Math.sign( dx ) || 1; d = - ox; }
				else if ( oy <= oz ) { ay = Math.sign( dy ) || 1; d = - oy; }
				else { az = Math.sign( dz ) || 1; d = - oz; }

				if ( d < deepest ) { deepest = d; nx = ax; ny = ay; nz = az; }

			}

			if ( deepest >= 0 ) break;

			this.position.x -= nx * deepest;
			this.position.y -= ny * deepest;
			this.position.z -= nz * deepest;

			const into = this.velocity.x * nx + this.velocity.y * ny + this.velocity.z * nz;

			if ( into < 0 ) {

				this.lastImpact = Math.max( this.lastImpact, - into );
				this.velocity.x -= nx * into;
				this.velocity.y -= ny * into;
				this.velocity.z -= nz * into;

			}

			if ( ny > 0.7 ) this.grounded = true;

		}

		this._resolvePanels( r );

	}

	// Panel collision, resolved against the open-cell grid rather than the slab.
	// An intact panel is solid; a breached one is solid everywhere except where
	// chunks have actually left, and the cells the player's radius spans must
	// *all* be open — the same test `_hasAperture` runs at build time, so what
	// the verifier proves and what the controls permit cannot drift apart.
	_resolvePanels( r ) {

		for ( let k = 0; k < this.panels.length; k ++ ) {

			const p = this.panels[ k ];
			const dx = this.position.x - p.center.x;
			const dy = this.position.y - p.center.y;
			const dz = this.position.z - p.center.z;

			const dn = dx * p.normal.x + dy * p.normal.y + dz * p.normal.z;
			const pen = p.halfN + r - Math.abs( dn );
			if ( pen <= 0 ) continue;

			const du = dx * p.axisU.x + dy * p.axisU.y + dz * p.axisU.z;
			const dv = dx * p.axisV.x + dy * p.axisV.y + dz * p.axisV.z;
			if ( Math.abs( du ) > p.halfU + r || Math.abs( dv ) > p.halfV + r ) continue;

			if ( p.activated && this._cellsOpen( p, du, dv, r ) ) continue;

			const s = dn >= 0 ? 1 : - 1;
			this.position.x += p.normal.x * s * pen;
			this.position.y += p.normal.y * s * pen;
			this.position.z += p.normal.z * s * pen;

			const into = ( this.velocity.x * p.normal.x + this.velocity.y * p.normal.y +
				this.velocity.z * p.normal.z ) * s;

			if ( into < 0 ) {

				this.lastImpact = Math.max( this.lastImpact, - into );
				this.velocity.x -= p.normal.x * s * into;
				this.velocity.y -= p.normal.y * s * into;
				this.velocity.z -= p.normal.z * s * into;

			}

		}

	}

	_cellsOpen( p, du, dv, r ) {

		const c0 = Math.max( 0, Math.floor( ( du - r + p.halfU ) / ( p.cellU * 2 ) ) );
		const c1 = Math.min( p.cols - 1, Math.floor( ( du + r + p.halfU ) / ( p.cellU * 2 ) ) );
		const r0 = Math.max( 0, Math.floor( ( dv - r + p.halfV ) / ( p.cellV * 2 ) ) );
		const r1 = Math.min( p.rows - 1, Math.floor( ( dv + r + p.halfV ) / ( p.cellV * 2 ) ) );

		for ( let rr = r0; rr <= r1; rr ++ ) {

			for ( let cc = c0; cc <= c1; cc ++ ) {

				if ( p.open[ rr * p.cols + cc ] === 0 ) return false;

			}

		}

		return true;

	}

	_updateView( dt, input ) {

		const T = TUNING;

		// Critically damped spring toward the physical transform. Heavier load,
		// longer trail — the orbit you are carrying is felt in the camera before
		// it is seen on screen.
		const lag = Math.max( 0.001, Math.min( T.cameraLagMax, T.cameraLag + this.load * T.cameraLagPerKg ) );
		const omega = 1 / lag;
		const dtc = Math.min( dt, 0.05 );

		_tmp.copy( this.position ).sub( this.viewPosition );
		this._viewVel.addScaledVector( _tmp, omega * omega * dtc );
		this._viewVel.multiplyScalar( Math.max( 0, 1 - 2 * omega * dtc ) );
		this.viewPosition.addScaledVector( this._viewVel, dtc );

		// Sway: a small lateral offset opposing lateral acceleration. Physically
		// wrong, reads as a body bracing (§47.2).
		_tmp.copy( _right ).multiplyScalar(
			- this.velocity.dot( _right ) * 0.006 * T.swayAmount
		);
		this.viewPosition.add( _tmp );

		const rotLag = 1 - Math.exp( - dtc / Math.max( 0.001, T.rotationLag ) );
		this.viewQuaternion.slerp( this.quaternion, rotLag );

	}

}
