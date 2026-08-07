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
// The model's shape is three-descent's exactly. The magnitudes are not: thrust,
// mouse sensitivity and arrow-key rotation were dialled in against this room by
// hand, because this room is 28m end to end rather than a mine. Each one notes
// what three-descent uses and why it moved. Press P in the running build to copy
// whatever you have dialled since.
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

	// Dialled in by hand against this room rather than inherited. thrustScale 1.0
	// is Descent's unscaled thrust and gives its real ~57 u/s terminal velocity,
	// which crosses this 28m room in half a second; 0.47 is about half that and
	// is what the room actually plays at.
	thrustScale: 0.47,
	burnMultiplier: 1.9,
	// three-descent's ROLL_THRUST_SCALE, unchanged.
	rollThrustScale: 1.6,
	// Keyboard pitch/yaw. At 1.0 this is full rated rotational thrust (~59 deg/s
	// terminal); 2.15 is a turn brisk enough to be worth reaching for instead of
	// the mouse.
	keyRotScale: 2.15,
	// three-descent runs 0.02. That is correct for its scale and far too slow
	// here, where the room is small and you are turning constantly — 0.35 is the
	// tested value. Anything near 0.9, which this started at, is unusable.
	mouseSensitivity: 0.35,
	invertY: false,

	// Bank into turns. Descent scales this straight off yaw *rate*
	// (TURNROLL_SCALE = 0.154 rad of bank per rad/s), which works there because
	// its mouse sensitivity keeps yaw rates low. At the sensitivities this build
	// runs, the same constant tilts the horizon 60 degrees on an ordinary turn
	// and rolls the ship completely over on a fast sweep — and because auto-level
	// subtracts the bank, it wrecks that too.
	//
	// So the rate coupling is gentler and the result is capped. The cap is what
	// actually matters: past it the bank stops tracking how hard you flicked,
	// which is the difference between leaning into a turn and being thrown by it.
	// Set bankScale to 0 for no bank at all; 0.154 is Descent's own number.
	bankScale: 0.064,
	bankMaxDeg: 10,

	cameraLag: 0.045,        // seconds of positional trail at zero load
	cameraLagPerKg: 0.00008,
	cameraLagMax: 0.16,
	rotationLag: 0.035,
	swayAmount: 0.6,

	autoLevel: true,
	autoLevelRate: 0.9
};

const FIXANG = Math.PI * 2 / 65536;
const TURNROLL_SCALE = 0.154;   // Descent's own bank-per-yaw-rate, for reference
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
		this._levelAxis = 2;   // +Y, the room's floor

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

		// Turn banking, three-descent's sequence exactly: un-apply the old bank,
		// integrate the rotation, compute the new bank, re-apply it. The bank has
		// to be a real rotation that gets removed and restored — tracking it as a
		// number and never rotating by it, which is what this did, means the ship
		// simply never banks into a turn.
		const oldTurnroll = this.turnroll;
		this._rotateLocal( 0, 0, 1, - oldTurnroll );

		const rv = this.rotVelocity;
		this._rotateLocal( 0, 1, 0, rv.y * dt );
		this._rotateLocal( 1, 0, 0, rv.x * dt );
		this._rotateLocal( 0, 0, 1, rv.z * dt );

		this._turnroll( dt );
		this._rotateLocal( 0, 0, 1, this.turnroll );

		// Manual roll wins outright, so auto-level cannot counter-steer against
		// Q/E in the same frame.
		const manualRoll = input.rollLeft || input.rollRight;
		if ( T.autoLevel && ! manualRoll ) this._autoLevel( dt );

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

		const cap = TUNING.bankMaxDeg * Math.PI / 180;
		let desired = this.rotVelocity.y * TUNING.bankScale;
		desired = desired < - cap ? - cap : ( desired > cap ? cap : desired );

		if ( this.turnroll !== desired ) {

			let maxRoll = ROLL_RATE * dt;
			const delta = desired - this.turnroll;

			if ( Math.abs( delta ) < maxRoll ) maxRoll = delta;
			else if ( delta < 0 ) maxRoll = - maxRoll;

			this.turnroll += maxRoll;

		}

	}

	// Surface anchoring (§3.3), and the important part is *what it levels to*.
	//
	// Descent picks the side normal of the segment you are in that is most
	// aligned with the ship's own up vector, then rolls you onto it. It does not
	// know about the world's floor and never pulls you back toward it. A box
	// room's six side normals are exactly the six world axes, so for this space
	// the algorithm reduces to snapping to whichever axis your up is nearest.
	//
	// That is the whole difference: aligning to world up means flying to the
	// ceiling rolls you to face the floor, which is what this was doing. Aligning
	// to the nearest axis means the ceiling becomes your floor when you are
	// oriented toward it, and a deliberate barrel roll settles into whichever of
	// the six orientations you left it nearest to.
	_autoLevel( dt ) {

		_up.set( 0, 1, 0 ).applyQuaternion( this.quaternion );
		_fwd.set( 0, 0, - 1 ).applyQuaternion( this.quaternion );

		let dx = 0, dy = 0, dz = 0, best = - Infinity, bestAxis = 0;

		for ( let a = 0; a < 6; a ++ ) {

			const s = a & 1 ? - 1 : 1;
			const ax = a < 2 ? s : 0;
			const ay = a >= 2 && a < 4 ? s : 0;
			const az = a >= 4 ? s : 0;
			let d = ax * _up.x + ay * _up.y + az * _up.z;
			// Hysteresis, so a ship sitting exactly between two faces does not
			// flip its target every frame and chatter in place.
			if ( a === this._levelAxis ) d += 0.06;
			if ( d > best ) { best = d; dx = ax; dy = ay; dz = az; bestAxis = a; }

		}

		this._levelAxis = bestAxis;

		// Nose pointing near-straight along the chosen up: there is no meaningful
		// roll to correct, so leave it alone.
		const dotWF = dx * _fwd.x + dy * _fwd.y + dz * _fwd.z;
		if ( Math.abs( dotWF ) >= 0.5 ) return;

		// Project the target up and the current up into the plane normal to forward.
		const px = dx - dotWF * _fwd.x, py = dy - dotWF * _fwd.y, pz = dz - dotWF * _fwd.z;
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

		// atan2 here is the rotation about *forward* that carries the current up
		// onto the target. The correction is applied about local +Z, and forward
		// is local -Z, so it has to be negated — three-descent does the same
		// negation by converting into Descent coordinates first. Without it the
		// ship rolls away from its target and parks on the 45-degree boundary
		// between two axes, which is where every orientation was ending up.
		//
		// The bank is subtracted rather than corrected: it was applied
		// deliberately this frame and auto-level should leave it alone.
		const delta = - Math.atan2( crossF, dot ) - this.turnroll;

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

				const dist = this.position.x * p.nx + this.position.y * p.ny + this.position.z * p.nz - p.d;
				const d = dist - r;
				if ( d >= deepest ) continue;

				// If the scan says the surface is gone here, it is gone here. This
				// is the difference between a cloud that is a skin over a solid room
				// and a cloud that *is* the room: you fly through the hole you cut,
				// and you cannot cut a hole you cannot fly through, because one
				// occupancy fact sits under both.
				//
				// The query has to be the point on the *surface*, not the point on
				// the player. Asking at the player's skin works right up until the
				// player penetrates, at which point the sample lands in the empty
				// space behind the wall, finds no data, and conservatively answers
				// "solid" — so the breach opens for every frame except the one that
				// matters.
				if ( this._open(
					this.position.x - p.nx * dist,
					this.position.y - p.ny * dist,
					this.position.z - p.nz * dist ) ) continue;

				deepest = d; nx = p.nx; ny = p.ny; nz = p.nz;

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

				if ( d >= deepest ) continue;

				// Same rule on the face the player is closest to leaving through.
				if ( this._open(
					ax !== 0 ? b.cx + ax * b.hx : this.position.x,
					ay !== 0 ? b.cy + ay * b.hy : this.position.y,
					az !== 0 ? b.cz + az * b.hz : this.position.z ) ) continue;

				deepest = d; nx = ax; ny = ay; nz = az;

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

	// Has this piece of surface stopped existing?
	_open( qx, qy, qz ) {

		return this.scan && this.scanActive ? this.scan.passable( qx, qy, qz ) : false;

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
