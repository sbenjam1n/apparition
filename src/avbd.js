// AVBD — Augmented Vertex Block Descent, adapted for "fake 6DOF particles".
//
// Method: Giles, Diaz & Yuksel, "Augmented Vertex Block Descent", ACM TOG 44(4)
// (SIGGRAPH 2025). Reference implementation (MIT, Chris Giles):
// https://github.com/savant117/avbd-demo2d
//
// What this file is, and what it deliberately is not:
//
// AVBD is a primal-dual position-based solver. Each iteration does a *block*
// descent step per body — solve one small SPD system for that body's own
// degrees of freedom, holding its neighbours fixed — then a dual update that
// raises a per-constraint penalty and accumulates a Lagrange multiplier. That
// buys unconditional stability at very low iteration counts, which is the only
// reason a few hundred tumbling chunks are affordable in JavaScript.
//
// The "fake" is in the collision layer, not the solver. Real 6DOF rigid bodies
// need mesh-vs-mesh narrow phase and a coupled 6x6 block solve. Here:
//
//   * A chunk is a box, but it only ever collides through its 8 corners against
//     static half-spaces and slabs. Corner-vs-plane gives an exact lever arm
//     r x n, which is all tumbling actually needs — it is what makes debris read
//     as rigid rather than as points.
//   * Chunk-vs-chunk skips SAT and uses two rounds of alternating closest-point
//     queries between the two boxes. Converges for the shallow contacts that
//     matter and, unlike bounding spheres, does not phantom-collide anything
//     elongated.
//   * The 6x6 block is split into two decoupled 3x3 blocks (linear, angular).
//     Dropping the off-diagonal coupling costs a little convergence per
//     iteration and saves most of the cost of the solve.
//
// This is the layer the design index calls cheap under dilation (§10.8): low
// relative velocities are exactly where a position-based solver converges in
// one or two iterations, so slow motion genuinely is the cheap case here.

const PENALTY_MIN = 1.0;
const PENALTY_MAX = 1e9;
const COLLISION_MARGIN = 0.002;

// Constraint rows per contact: 1 normal + 2 friction.
const ROWS = 3;
const CORNERS = 8;

// Static collider index space is shared by planes and boxes so a warm-start
// slot is a plain (body, corner, collider) triple with no hashing.
const MAX_COLLIDERS = 24;

const CORNER_SIGN = new Float32Array( [
	- 1, - 1, - 1, 1, - 1, - 1, - 1, 1, - 1, 1, 1, - 1,
	- 1, - 1, 1, 1, - 1, 1, - 1, 1, 1, 1, 1, 1
] );

// Solve a 3x3 symmetric positive-definite system by LDL^T. `a` is upper
// triangle row-major: [a00 a01 a02 a11 a12 a22]. Writes the solution to out.
function solveSPD3( a, b0, b1, b2, out ) {

	const d0 = a[ 0 ];

	if ( d0 < 1e-12 ) { out[ 0 ] = 0; out[ 1 ] = 0; out[ 2 ] = 0; return; }

	const l10 = a[ 1 ] / d0;
	const l20 = a[ 2 ] / d0;
	const d1 = a[ 3 ] - l10 * l10 * d0;

	if ( d1 < 1e-12 ) { out[ 0 ] = 0; out[ 1 ] = 0; out[ 2 ] = 0; return; }

	const l21 = ( a[ 4 ] - l20 * l10 * d0 ) / d1;
	const d2 = a[ 5 ] - l20 * l20 * d0 - l21 * l21 * d1;

	if ( d2 < 1e-12 ) { out[ 0 ] = 0; out[ 1 ] = 0; out[ 2 ] = 0; return; }

	// Forward substitution (L y = b), diagonal scale, back substitution.
	const y0 = b0;
	const y1 = b1 - l10 * y0;
	const y2 = b2 - l20 * y0 - l21 * y1;

	const z2 = y2 / d2;
	const z1 = y1 / d1 - l21 * z2;
	const z0 = y0 / d0 - l10 * z1 - l20 * z2;

	out[ 0 ] = z0;
	out[ 1 ] = z1;
	out[ 2 ] = z2;

}

export class AVBDSolver {

	constructor( maxBodies = 640 ) {

		const N = maxBodies;
		this.maxBodies = N;
		this.count = 0;

		// Primal state.
		this.px = new Float32Array( N ); this.py = new Float32Array( N ); this.pz = new Float32Array( N );
		this.qx = new Float32Array( N ); this.qy = new Float32Array( N );
		this.qz = new Float32Array( N ); this.qw = new Float32Array( N );

		// x^- : position and orientation at the top of the step, for BDF1.
		this.ix = new Float32Array( N ); this.iy = new Float32Array( N ); this.iz = new Float32Array( N );
		this.iqx = new Float32Array( N ); this.iqy = new Float32Array( N );
		this.iqz = new Float32Array( N ); this.iqw = new Float32Array( N );

		// x~ : the inertial (unconstrained) prediction the solver pulls toward.
		this.nx = new Float32Array( N ); this.ny = new Float32Array( N ); this.nz = new Float32Array( N );
		this.nqx = new Float32Array( N ); this.nqy = new Float32Array( N );
		this.nqz = new Float32Array( N ); this.nqw = new Float32Array( N );

		this.vx = new Float32Array( N ); this.vy = new Float32Array( N ); this.vz = new Float32Array( N );
		this.wx = new Float32Array( N ); this.wy = new Float32Array( N ); this.wz = new Float32Array( N );
		// Velocity at the top of the step: vy drives the adaptive warm start, and
		// the full vector is the only honest way to measure an impact — after
		// _computeVelocities the current velocity IS the post-contact one.
		this.pvx = new Float32Array( N );
		this.pvy = new Float32Array( N );
		this.pvz = new Float32Array( N );

		this.hx = new Float32Array( N ); this.hy = new Float32Array( N ); this.hz = new Float32Array( N );
		this.mass = new Float32Array( N );
		this.invMass = new Float32Array( N );
		this.inertia = new Float32Array( N );
		this.invInertia = new Float32Array( N );
		this.radius = new Float32Array( N );
		this.friction = new Float32Array( N );
		this.material = new Uint8Array( N );
		// World rotation matrices, rebuilt once per step and shared by the static
		// and pair contact passes.
		this.rot = new Float32Array( N * 9 );

		// 0 = free slot, 1 = simulating, 2 = asleep (skipped by the solve).
		this.state = new Uint8Array( N );
		this.restTimer = new Float32Array( N );
		this.age = new Float32Array( N );
		this.freeList = [];

		for ( let i = N - 1; i >= 0; i -- ) this.freeList.push( i );

		// Warm-started duals for static contacts. Persisting lambda across steps
		// is what makes resting piles settle instead of jittering; AVBD Eq. 19.
		const slots = N * CORNERS * MAX_COLLIDERS * ROWS;
		this.lambda = new Float32Array( slots );
		this.penalty = new Float32Array( slots );
		// Friction anchor (the "stick" point) in world space, per contact.
		this.anchorX = new Float32Array( slots / ROWS );
		this.anchorY = new Float32Array( slots / ROWS );
		this.anchorZ = new Float32Array( slots / ROWS );
		this.anchorLive = new Uint8Array( slots / ROWS );

		// --- joints ----------------------------------------------------------
		//
		// Six-row welds: three linear rows holding a pair of anchor points
		// coincident, three angular rows holding a relative orientation. Both
		// bilateral (unbounded force) and both hard, so they run on the lambda
		// path rather than the penalty path.
		//
		// Fracture triggers on |lambda|, not on stretch. That distinction is the
		// whole reason this is worth doing: lambda IS the force carried by the
		// constraint, in newtons, so "this joint shears at 3kN" survives every
		// change to stiffness, iteration count and timestep. A stretch threshold
		// has to be re-tuned every time any of those move.
		const J = this.maxJoints = 768;
		this.jointCount = 0;
		this.jA = new Int32Array( J );
		this.jB = new Int32Array( J );          // -1 = anchored to the static world
		this.jax = new Float32Array( J ); this.jay = new Float32Array( J ); this.jaz = new Float32Array( J );
		this.jbx = new Float32Array( J ); this.jby = new Float32Array( J ); this.jbz = new Float32Array( J );
		// Target orientation for A: (dynamic) qB * conj(qRel), (static) a constant.
		this.jrx = new Float32Array( J ); this.jry = new Float32Array( J );
		this.jrz = new Float32Array( J ); this.jrw = new Float32Array( J );
		this.jLambda = new Float32Array( J * 6 );
		this.jPenalty = new Float32Array( J * 6 );
		this.jC = new Float32Array( J * 6 );
		this.jRax = new Float32Array( J ); this.jRay = new Float32Array( J ); this.jRaz = new Float32Array( J );
		this.jRbx = new Float32Array( J ); this.jRby = new Float32Array( J ); this.jRbz = new Float32Array( J );
		this.jBreakForce = new Float32Array( J );
		this.jBreakTorque = new Float32Array( J );
		// Yield is the fraction of the break load past which damage accumulates.
		// Below yield a joint is elastic forever; above it, it creeps and then
		// lets go later — which is what makes a panel sag before it drops.
		this.jYield = new Float32Array( J );
		this.jDamage = new Float32Array( J );
		// Fracture reads a short moving average of |lambda|, not its instantaneous
		// value. A freshly built lattice takes a second or two to converge and
		// lambda overshoots badly while it does — measured at ~8kN peak against a
		// ~1kN steady state on a 42-chunk panel. Testing the raw value fractures a
		// wall for standing still. A real impact is an order of magnitude larger
		// again and survives the filter intact, so this discriminates convergence
		// noise from load without blunting anything that matters.
		this.jLoadF = new Float32Array( J );
		this.jLoadT = new Float32Array( J );
		// And a grace window on new joints, so the initial settle is never read.
		this.jSettle = new Float32Array( J );
		this.jGroup = new Int32Array( J );      // owner id, for connectivity queries
		this.jState = new Uint8Array( J );      // 0 = free, 1 = intact, 2 = broken
		this.jointFreeList = [];

		for ( let i = J - 1; i >= 0; i -- ) this.jointFreeList.push( i );

		this.bodyJointStart = new Int32Array( N + 1 );
		this.bodyJointList = new Int32Array( J * 2 );

		// Bodies that share a joint must not also generate contacts against each
		// other. The weld already fixes their relative position, so a contact is
		// redundant — and worse, the contact pushes them apart while the weld
		// pulls them together, which spikes lambda and tears a lattice apart under
		// its own weight. The AVBD reference has the same guard (`constrainedTo`).
		// Counted, because a pair can be welded more than once, and it lapses the
		// moment the last weld goes so broken chunks start pressing properly.
		this.jointPairs = new Map();

		this.creepRate = 0.55;     // damage per second at twice yield load
		// A weld seeded at PENALTY_MIN is effectively soft for its first few dozen
		// steps, so a fresh lattice sags and lambda overshoots for seconds while
		// the ramp catches up. Seeding the penalty high instead means the
		// constraint is enforced from step one and there is no settle transient to
		// filter out — which matters because the transient is *slow* and an impact
		// is two frames, so no low-pass can separate them. Fix the cause.
		this.jointPenaltyInit = 1e5;
		this.jointBeta = 2e6;
		this.loadFilter = 0.035;   // just enough to reject single-frame numerics
		this.jointSettleTime = 0.35;
		this.onFracture = null;    // ( jointIndex, force, x, y, z, group ) => void

		// Static world.
		this.planes = [];  // { nx, ny, nz, d, friction, material } valid where n.x >= d
		this.boxes = [];   // { cx, cy, cz, hx, hy, hz, friction, material } solid, keep out

		// Per-step contact scratch, grown on demand.
		this._contactCap = 4096;
		this._allocContacts( this._contactCap );

		// Tunables. beta/alpha/gamma follow the reference implementation; beta is
		// unit-dependent and this one is tuned for a metres-and-kilograms world.
		this.gravity = - 9.81;
		this.iterations = 6;
		this.beta = 5e4;
		this.alpha = 0.99;
		this.gamma = 0.99;
		this.postStabilize = true;
		// A position-based solver leaves a little residual jitter at rest; these
		// sit just above it so piles actually go quiet. Too low and nothing ever
		// sleeps, which is the single biggest cost sink in the whole field.
		this.sleepLinear = 0.14;
		this.sleepAngular = 0.5;
		this.sleepTime = 0.5;   // §23.6: correct behaviour for roughly 500ms
		this.maxAngular = 40.0;
		// A substep must not carry anything further than the thinnest thing it can
		// hit. Panels are 0.28m, so 0.14 leaves a factor of two and costs half as
		// much as being paranoid about it.
		this.maxTravel = 0.14;
		this.maxSubsteps = 3;
		this._maxRadius = 0.1;

		this._a = new Float32Array( 6 );
		this._b = new Float32Array( 6 );
		this._out = new Float32Array( 3 );
		this._out2 = new Float32Array( 3 );

		this.onImpact = null;   // ( bodyIndex, speed, x, y, z, material ) => void
		this.stats = { active: 0, asleep: 0, contacts: 0, substeps: 1 };

	}

	_allocContacts( cap ) {

		this._contactCap = cap;
		this.cBody = new Int32Array( cap );
		this.cBodyB = new Int32Array( cap );      // -1 for static contacts
		this.cSlot = new Int32Array( cap );       // -1 when not warm-started
		this.cNx = new Float32Array( cap ); this.cNy = new Float32Array( cap ); this.cNz = new Float32Array( cap );
		this.cT1x = new Float32Array( cap ); this.cT1y = new Float32Array( cap ); this.cT1z = new Float32Array( cap );
		this.cT2x = new Float32Array( cap ); this.cT2y = new Float32Array( cap ); this.cT2z = new Float32Array( cap );
		this.cRax = new Float32Array( cap ); this.cRay = new Float32Array( cap ); this.cRaz = new Float32Array( cap );
		this.cRbx = new Float32Array( cap ); this.cRby = new Float32Array( cap ); this.cRbz = new Float32Array( cap );
		// Local-space corner on body A, so the constraint can be re-evaluated as
		// the body rotates during the iteration sweep rather than frozen at setup.
		this.cLax = new Float32Array( cap ); this.cLay = new Float32Array( cap ); this.cLaz = new Float32Array( cap );
		this.cAnchorX = new Float32Array( cap ); this.cAnchorY = new Float32Array( cap ); this.cAnchorZ = new Float32Array( cap );
		this.cPlaneD = new Float32Array( cap );
		this.cFriction = new Float32Array( cap );
		this.cLambda = new Float32Array( cap * ROWS );
		this.cPenalty = new Float32Array( cap * ROWS );
		this.cC = new Float32Array( cap * ROWS );
		this.numContacts = 0;

		// Per-body contact adjacency, rebuilt each step.
		this.bodyContactStart = new Int32Array( this.maxBodies + 1 );
		this.bodyContactList = new Int32Array( cap * 2 );

	}

	addPlane( nx, ny, nz, d, friction = 0.6, material = 0 ) {

		if ( this.planes.length + this.boxes.length >= MAX_COLLIDERS ) return - 1;
		this.planes.push( { nx, ny, nz, d, friction, material } );
		return this.planes.length - 1;

	}

	addBox( cx, cy, cz, hx, hy, hz, friction = 0.6, material = 0 ) {

		if ( this.planes.length + this.boxes.length >= MAX_COLLIDERS ) return - 1;
		this.boxes.push( { cx, cy, cz, hx, hy, hz, friction, material } );
		return this.planes.length + this.boxes.length - 1;

	}

	spawn( x, y, z, hx, hy, hz, density = 1.0, material = 0 ) {

		if ( this.freeList.length === 0 ) {

			// Recycle the oldest sleeping body rather than dropping the spawn:
			// a wall that stops shedding chunks reads as a bug, an old pile
			// quietly vanishing does not.
			let oldest = - 1, oldestAge = - 1;

			for ( let i = 0; i < this.maxBodies; i ++ ) {

				if ( this.state[ i ] === 2 && this.age[ i ] > oldestAge ) { oldestAge = this.age[ i ]; oldest = i; }

			}

			if ( oldest < 0 ) return - 1;
			this.release( oldest );

		}

		const i = this.freeList.pop();
		// density is specific gravity; x1000 puts mass in kilograms.
		const m = 8 * hx * hy * hz * density * 1000;

		this.px[ i ] = x; this.py[ i ] = y; this.pz[ i ] = z;
		this.qx[ i ] = 0; this.qy[ i ] = 0; this.qz[ i ] = 0; this.qw[ i ] = 1;
		this.vx[ i ] = 0; this.vy[ i ] = 0; this.vz[ i ] = 0;
		this.wx[ i ] = 0; this.wy[ i ] = 0; this.wz[ i ] = 0;
		this.pvx[ i ] = 0; this.pvy[ i ] = 0; this.pvz[ i ] = 0;
		this.hx[ i ] = hx; this.hy[ i ] = hy; this.hz[ i ] = hz;
		this.mass[ i ] = m;
		this.invMass[ i ] = 1 / m;
		// Mean of the three box principal moments — one scalar inertia keeps the
		// angular block isotropic, so it never needs rotating into world space.
		const I = m * 2 * ( hx * hx + hy * hy + hz * hz ) / 9;
		this.inertia[ i ] = I;
		this.invInertia[ i ] = 1 / I;
		this.radius[ i ] = Math.sqrt( hx * hx + hy * hy + hz * hz );
		if ( this.radius[ i ] > this._maxRadius ) this._maxRadius = this.radius[ i ];
		this.friction[ i ] = 0.55;
		this.material[ i ] = material;
		this.state[ i ] = 1;
		this.restTimer[ i ] = 0;
		this.age[ i ] = 0;

		this._clearWarmStart( i );
		if ( i >= this.count ) this.count = i + 1;
		return i;

	}

	release( i ) {

		if ( this.state[ i ] === 0 ) return;
		this.state[ i ] = 0;
		this.freeList.push( i );

	}

	_clearWarmStart( i ) {

		const base = i * CORNERS * MAX_COLLIDERS;
		this.lambda.fill( 0, base * ROWS, ( base + CORNERS * MAX_COLLIDERS ) * ROWS );
		this.penalty.fill( PENALTY_MIN, base * ROWS, ( base + CORNERS * MAX_COLLIDERS ) * ROWS );
		this.anchorLive.fill( 0, base, base + CORNERS * MAX_COLLIDERS );

	}

	wake( i ) {

		if ( this.state[ i ] === 2 ) { this.state[ i ] = 1; this.restTimer[ i ] = 0; }

	}

	applyImpulse( i, ix, iy, iz, rx = 0, ry = 0, rz = 0 ) {

		if ( this.state[ i ] === 0 ) return;
		this.wake( i );
		const im = this.invMass[ i ];
		this.vx[ i ] += ix * im; this.vy[ i ] += iy * im; this.vz[ i ] += iz * im;
		const ii = this.invInertia[ i ];
		this.wx[ i ] += ( ry * iz - rz * iy ) * ii;
		this.wy[ i ] += ( rz * ix - rx * iz ) * ii;
		this.wz[ i ] += ( rx * iy - ry * ix ) * ii;

	}

	// Wake everything within `r` of a point — used by impacts and telekinesis so
	// a settled pile reacts instead of sitting there like scenery.
	wakeRadius( x, y, z, r ) {

		const r2 = r * r;

		for ( let i = 0; i < this.count; i ++ ) {

			if ( this.state[ i ] !== 2 ) continue;
			const dx = this.px[ i ] - x, dy = this.py[ i ] - y, dz = this.pz[ i ] - z;
			if ( dx * dx + dy * dy + dz * dz < r2 ) this.wake( i );

		}

	}

	// --- joints -------------------------------------------------------------

	// Rotate a world offset into body i's local frame.
	_toLocal( i, wx, wy, wz, out ) {

		const dx = wx - this.px[ i ], dy = wy - this.py[ i ], dz = wz - this.pz[ i ];
		const qx = - this.qx[ i ], qy = - this.qy[ i ], qz = - this.qz[ i ], qw = this.qw[ i ];
		const tx = 2 * ( qy * dz - qz * dy );
		const ty = 2 * ( qz * dx - qx * dz );
		const tz = 2 * ( qx * dy - qy * dx );
		out[ 0 ] = dx + qw * tx + qy * tz - qz * ty;
		out[ 1 ] = dy + qw * ty + qz * tx - qx * tz;
		out[ 2 ] = dz + qw * tz + qx * ty - qy * tx;

	}

	// Weld body a to body b (or to the world, b = -1) at a world point. The rest
	// state is whatever the two bodies are in right now, so panels are authored by
	// placing chunks and then jointing them where they touch.
	addJoint( a, b, wx, wy, wz, breakForce, breakTorque, yieldFraction = 0.55, group = - 1 ) {

		if ( this.jointFreeList.length === 0 ) return - 1;
		if ( this.state[ a ] === 0 ) return - 1;
		if ( b >= 0 && this.state[ b ] === 0 ) return - 1;

		const j = this.jointFreeList.pop();
		const t = this._out;

		this._toLocal( a, wx, wy, wz, t );
		this.jax[ j ] = t[ 0 ]; this.jay[ j ] = t[ 1 ]; this.jaz[ j ] = t[ 2 ];

		if ( b >= 0 ) {

			this._toLocal( b, wx, wy, wz, t );
			this.jbx[ j ] = t[ 0 ]; this.jby[ j ] = t[ 1 ]; this.jbz[ j ] = t[ 2 ];

			// qRel = conj(qA) * qB, so the target for A is qB * conj(qRel).
			const ax = - this.qx[ a ], ay = - this.qy[ a ], az = - this.qz[ a ], aw = this.qw[ a ];
			const bx = this.qx[ b ], by = this.qy[ b ], bz = this.qz[ b ], bw = this.qw[ b ];
			this.jrx[ j ] = aw * bx + ax * bw + ay * bz - az * by;
			this.jry[ j ] = aw * by - ax * bz + ay * bw + az * bx;
			this.jrz[ j ] = aw * bz + ax * by - ay * bx + az * bw;
			this.jrw[ j ] = aw * bw - ax * bx - ay * by - az * bz;

		} else {

			// World anchor and a fixed absolute rest orientation.
			this.jbx[ j ] = wx; this.jby[ j ] = wy; this.jbz[ j ] = wz;
			this.jrx[ j ] = this.qx[ a ]; this.jry[ j ] = this.qy[ a ];
			this.jrz[ j ] = this.qz[ a ]; this.jrw[ j ] = this.qw[ a ];

		}

		this.jA[ j ] = a;
		this.jB[ j ] = b;
		this.jBreakForce[ j ] = breakForce;
		this.jBreakTorque[ j ] = breakTorque;
		this.jYield[ j ] = yieldFraction;
		this.jDamage[ j ] = 0;
		this.jLoadF[ j ] = 0;
		this.jLoadT[ j ] = 0;
		this.jSettle[ j ] = this.jointSettleTime;
		this.jGroup[ j ] = group;
		this.jState[ j ] = 1;

		for ( let r = 0; r < 6; r ++ ) { this.jLambda[ j * 6 + r ] = 0; this.jPenalty[ j * 6 + r ] = this.jointPenaltyInit; }

		if ( b >= 0 ) {

			const key = this._pairKey( a, b );
			this.jointPairs.set( key, ( this.jointPairs.get( key ) || 0 ) + 1 );

		}

		if ( j >= this.jointCount ) this.jointCount = j + 1;
		return j;

	}

	_pairKey( a, b ) {

		return a < b ? a * 65536 + b : b * 65536 + a;

	}

	breakJoint( j ) {

		if ( this.jState[ j ] !== 1 ) return;
		this.jState[ j ] = 2;
		this.jointFreeList.push( j );

		const b = this.jB[ j ];

		if ( b >= 0 ) {

			const key = this._pairKey( this.jA[ j ], b );
			const n = ( this.jointPairs.get( key ) || 1 ) - 1;
			if ( n <= 0 ) this.jointPairs.delete( key );
			else this.jointPairs.set( key, n );

		}

		// Wake both ends. A joint letting go redistributes load onto its
		// neighbours, and a sleeping neighbour would swallow that silently.
		this.wake( this.jA[ j ] );
		if ( this.jB[ j ] >= 0 ) this.wake( this.jB[ j ] );

	}

	// Wake everything one joint-hop away. Cheap, and it is what makes load
	// actually travel through a lattice instead of stopping at the impact.
	wakeJointNeighbours( i ) {

		for ( let j = 0; j < this.jointCount; j ++ ) {

			if ( this.jState[ j ] !== 1 ) continue;
			if ( this.jA[ j ] === i && this.jB[ j ] >= 0 ) this.wake( this.jB[ j ] );
			else if ( this.jB[ j ] === i ) this.wake( this.jA[ j ] );

		}

	}

	_buildJointAdjacency() {

		const counts = this.bodyJointStart;
		counts.fill( 0 );

		for ( let j = 0; j < this.jointCount; j ++ ) {

			if ( this.jState[ j ] !== 1 ) continue;

			// A joint whose body was recycled is stale; retire it quietly.
			if ( this.state[ this.jA[ j ] ] === 0 || ( this.jB[ j ] >= 0 && this.state[ this.jB[ j ] ] === 0 ) ) {

				this.breakJoint( j );
				continue;

			}

			counts[ this.jA[ j ] + 1 ] ++;
			if ( this.jB[ j ] >= 0 ) counts[ this.jB[ j ] + 1 ] ++;

		}

		for ( let i = 0; i < this.maxBodies; i ++ ) counts[ i + 1 ] += counts[ i ];

		const cursor = this._jcursor || ( this._jcursor = new Int32Array( this.maxBodies ) );
		cursor.set( counts.subarray( 0, this.maxBodies ) );

		for ( let j = 0; j < this.jointCount; j ++ ) {

			if ( this.jState[ j ] !== 1 ) continue;
			this.bodyJointList[ cursor[ this.jA[ j ] ] ++ ] = j;
			if ( this.jB[ j ] >= 0 ) this.bodyJointList[ cursor[ this.jB[ j ] ] ++ ] = ~ j;

		}

	}

	// Six constraint values plus the world lever arms, for the current primal state.
	_evalJoint( j, alpha ) {

		const a = this.jA[ j ], b = this.jB[ j ];
		const base = j * 6;

		// Linear: the two anchors should be coincident.
		const t = this._jtmp || ( this._jtmp = new Float32Array( 6 ) );
		this._rotate( a, this.jax[ j ], this.jay[ j ], this.jaz[ j ], t, 0 );
		this.jRax[ j ] = t[ 0 ]; this.jRay[ j ] = t[ 1 ]; this.jRaz[ j ] = t[ 2 ];

		const wax = this.px[ a ] + t[ 0 ], way = this.py[ a ] + t[ 1 ], waz = this.pz[ a ] + t[ 2 ];
		let wbx, wby, wbz;
		let tqx, tqy, tqz, tqw;

		if ( b >= 0 ) {

			this._rotate( b, this.jbx[ j ], this.jby[ j ], this.jbz[ j ], t, 3 );
			this.jRbx[ j ] = t[ 3 ]; this.jRby[ j ] = t[ 4 ]; this.jRbz[ j ] = t[ 5 ];
			wbx = this.px[ b ] + t[ 3 ]; wby = this.py[ b ] + t[ 4 ]; wbz = this.pz[ b ] + t[ 5 ];

			// qTarget = qB * conj(qRel)
			const bx = this.qx[ b ], by = this.qy[ b ], bz = this.qz[ b ], bw = this.qw[ b ];
			const rx = - this.jrx[ j ], ry = - this.jry[ j ], rz = - this.jrz[ j ], rw = this.jrw[ j ];
			tqx = bw * rx + bx * rw + by * rz - bz * ry;
			tqy = bw * ry - bx * rz + by * rw + bz * rx;
			tqz = bw * rz + bx * ry - by * rx + bz * rw;
			tqw = bw * rw - bx * rx - by * ry - bz * rz;

		} else {

			wbx = this.jbx[ j ]; wby = this.jby[ j ]; wbz = this.jbz[ j ];
			tqx = this.jrx[ j ]; tqy = this.jry[ j ]; tqz = this.jrz[ j ]; tqw = this.jrw[ j ];

		}

		this.jC[ base ] = ( wax - wbx ) * alpha;
		this.jC[ base + 1 ] = ( way - wby ) * alpha;
		this.jC[ base + 2 ] = ( waz - wbz ) * alpha;

		// Angular: world-frame rotation vector from the target orientation to A's.
		const ax = this.qx[ a ], ay = this.qy[ a ], az = this.qz[ a ], aw = this.qw[ a ];
		const cx = - tqx, cy = - tqy, cz = - tqz, cw = tqw;
		const ex = aw * cx + ax * cw + ay * cz - az * cy;
		const ey = aw * cy - ax * cz + ay * cw + az * cx;
		const ez = aw * cz + ax * cy - ay * cx + az * cw;
		const ew = aw * cw - ax * cx - ay * cy - az * cz;
		const s = ( ew < 0 ? - 2 : 2 ) * alpha;

		this.jC[ base + 3 ] = ex * s;
		this.jC[ base + 4 ] = ey * s;
		this.jC[ base + 5 ] = ez * s;

	}

	// Rotate a local offset into world by body i's orientation, into out[off..off+2].
	_rotate( i, lx, ly, lz, out, off ) {

		const qx = this.qx[ i ], qy = this.qy[ i ], qz = this.qz[ i ], qw = this.qw[ i ];
		const tx = 2 * ( qy * lz - qz * ly );
		const ty = 2 * ( qz * lx - qx * lz );
		const tz = 2 * ( qx * ly - qy * lx );
		out[ off ] = lx + qw * tx + qy * tz - qz * ty;
		out[ off + 1 ] = ly + qw * ty + qz * tx - qx * tz;
		out[ off + 2 ] = lz + qw * tz + qx * ty - qy * tx;

	}

	_jointDualUpdate( alpha ) {

		for ( let j = 0; j < this.jointCount; j ++ ) {

			if ( this.jState[ j ] !== 1 ) continue;
			this._evalJoint( j, alpha );

			const base = j * 6;

			for ( let r = 0; r < 6; r ++ ) {

				const idx = base + r;
				// Bilateral: no clamp, so lambda is free to take whatever force the
				// weld is actually carrying — which is exactly what fracture reads.
				this.jLambda[ idx ] = this.jPenalty[ idx ] * this.jC[ idx ] + this.jLambda[ idx ];
				const p = this.jPenalty[ idx ] + this.jointBeta * Math.abs( this.jC[ idx ] );
				this.jPenalty[ idx ] = p > PENALTY_MAX ? PENALTY_MAX : p;

			}

		}

	}

	// Fracture and creep, evaluated once per step on the converged multipliers
	// rather than mid-sweep — a joint that dips over threshold during iteration 2
	// and back under by iteration 6 was never actually overloaded.
	_jointFracture( dt ) {

		for ( let j = 0; j < this.jointCount; j ++ ) {

			if ( this.jState[ j ] !== 1 ) continue;

			const base = j * 6;
			const fx = this.jLambda[ base ], fy = this.jLambda[ base + 1 ], fz = this.jLambda[ base + 2 ];
			const tx = this.jLambda[ base + 3 ], ty = this.jLambda[ base + 4 ], tz = this.jLambda[ base + 5 ];

			const rawF = Math.sqrt( fx * fx + fy * fy + fz * fz );
			const rawT = Math.sqrt( tx * tx + ty * ty + tz * tz );

			const k = Math.min( 1, dt / this.loadFilter );
			this.jLoadF[ j ] += ( rawF - this.jLoadF[ j ] ) * k;
			this.jLoadT[ j ] += ( rawT - this.jLoadT[ j ] ) * k;

			if ( this.jSettle[ j ] > 0 ) { this.jSettle[ j ] -= dt; continue; }

			const force = this.jLoadF[ j ];
			const torque = this.jLoadT[ j ];

			// Damage shrinks the effective break load, so a joint that has been
			// worked stays weaker. Persistent under §7.5 for as long as it lives.
			const capF = this.jBreakForce[ j ] * ( 1 - this.jDamage[ j ] );
			const capT = this.jBreakTorque[ j ] * ( 1 - this.jDamage[ j ] );

			if ( force >= capF || torque >= capT ) {

				const a = this.jA[ j ];
				const x = this.px[ a ] + this.jRax[ j ];
				const y = this.py[ a ] + this.jRay[ j ];
				const z = this.pz[ a ] + this.jRaz[ j ];
				const group = this.jGroup[ j ];
				this.breakJoint( j );
				if ( this.onFracture ) this.onFracture( j, Math.max( force, torque * 4 ), x, y, z, group );
				continue;

			}

			// Creep. Above yield the joint accumulates damage and will let go
			// seconds later rather than at the moment of the hit — the delayed
			// shred, and under dilation those seconds are a very long time.
			const yF = capF * this.jYield[ j ];
			const yT = capT * this.jYield[ j ];
			const over = Math.max(
				yF > 0 ? ( force - yF ) / yF : 0,
				yT > 0 ? ( torque - yT ) / yT : 0
			);

			if ( over > 0 ) {

				this.jDamage[ j ] = Math.min( 0.98, this.jDamage[ j ] + over * this.creepRate * dt );
				this.wake( this.jA[ j ] );
				if ( this.jB[ j ] >= 0 ) this.wake( this.jB[ j ] );

			}

		}

	}

	// Adaptive substepping.
	//
	// Contact generation is discrete: a body is tested where it is, not along the
	// path it took. So anything travelling further than the thickness of what it
	// hits passes clean through — at 60Hz, 20m/s is 0.33m per step against a 0.28m
	// wall panel, and the wall may as well not be there. Since AVBD is cheap and
	// unconditionally stable, the fix is to subdivide the step so nothing ever
	// moves more than `maxTravel` at a time. Costs nothing at rest, because k is 1
	// unless something is actually fast.
	step( dt ) {

		if ( dt <= 0 ) return;

		let maxV = 0;

		for ( let i = 0; i < this.count; i ++ ) {

			if ( this.state[ i ] !== 1 ) continue;
			const v = this.vx[ i ] * this.vx[ i ] + this.vy[ i ] * this.vy[ i ] + this.vz[ i ] * this.vz[ i ];
			if ( v > maxV ) maxV = v;

		}

		const k = Math.min( this.maxSubsteps,
			Math.max( 1, Math.ceil( Math.sqrt( maxV ) * dt / this.maxTravel ) ) );
		this.stats.substeps = k;

		const h = dt / k;
		for ( let n = 0; n < k; n ++ ) this._substep( h );

	}

	_substep( dt ) {

		const invDt = 1 / dt;
		const invDt2 = invDt * invDt;

		// Contacts seed their penalty from inertia, so the solver needs the step.
		this._dt = dt;
		this._integrateAndWarmStart( dt );
		this._warmStartJoints();
		this._buildContacts();
		this._buildAdjacency();
		this._buildJointAdjacency();

		const iters = this.iterations;
		const total = iters + ( this.postStabilize ? 1 : 0 );

		for ( let it = 0; it < total; it ++ ) {

			// Post-stabilisation runs one extra iteration with alpha = 0, which
			// removes accumulated positional error in one shot instead of
			// bleeding it out over frames.
			const alpha = this.postStabilize ? ( it < iters ? 1.0 : 0.0 ) : this.alpha;

			this._primalUpdate( invDt2, alpha );

			if ( it < iters ) {

				this._dualUpdate( alpha );
				this._jointDualUpdate( alpha );

			}

			if ( it === iters - 1 ) this._computeVelocities( invDt );

		}

		this._jointFracture( dt );
		this._finish( dt );

	}

	_integrateAndWarmStart( dt ) {

		const g = this.gravity;

		for ( let i = 0; i < this.count; i ++ ) {

			if ( this.state[ i ] !== 1 ) continue;

			this.age[ i ] += dt;

			// Clamp spin. Chunks that spin arbitrarily fast are both unstable and
			// unreadable; nothing about the look needs more than a few rev/s.
			let w2 = this.wx[ i ] * this.wx[ i ] + this.wy[ i ] * this.wy[ i ] + this.wz[ i ] * this.wz[ i ];

			if ( w2 > this.maxAngular * this.maxAngular ) {

				const s = this.maxAngular / Math.sqrt( w2 );
				this.wx[ i ] *= s; this.wy[ i ] *= s; this.wz[ i ] *= s;

			}

			// x^- (Eq. 2 setup)
			this.ix[ i ] = this.px[ i ]; this.iy[ i ] = this.py[ i ]; this.iz[ i ] = this.pz[ i ];
			this.iqx[ i ] = this.qx[ i ]; this.iqy[ i ] = this.qy[ i ];
			this.iqz[ i ] = this.qz[ i ]; this.iqw[ i ] = this.qw[ i ];

			// Inertial prediction x~ = x + v dt + g dt^2
			this.nx[ i ] = this.px[ i ] + this.vx[ i ] * dt;
			this.ny[ i ] = this.py[ i ] + this.vy[ i ] * dt + g * dt * dt;
			this.nz[ i ] = this.pz[ i ] + this.vz[ i ] * dt;

			// Angular prediction: no external torque, so it is free rotation.
			this._integrateQuat( i, dt, this.nqx, this.nqy, this.nqz, this.nqw );

			// Adaptive warm start (original VBD): only lean on gravity for the
			// initial guess when the body is actually in free fall. A body that
			// is already resting gets no gravity push, so it does not sink and
			// climb back out every frame.
			const accelY = ( this.vy[ i ] - this.pvy[ i ] ) / dt;
			let weight = accelY * Math.sign( g ) / Math.abs( g );
			if ( ! isFinite( weight ) ) weight = 0;
			weight = weight < 0 ? 0 : ( weight > 1 ? 1 : weight );

			this.px[ i ] = this.px[ i ] + this.vx[ i ] * dt;
			this.py[ i ] = this.py[ i ] + this.vy[ i ] * dt + g * ( weight * dt * dt );
			this.pz[ i ] = this.pz[ i ] + this.vz[ i ] * dt;
			this._integrateQuat( i, dt, this.qx, this.qy, this.qz, this.qw );

		}

	}

	// Joints warm-start like contacts (Eq. 19): keep the full lambda under post
	// stabilisation, decay only the penalty. Carrying lambda is what lets a weld
	// hold a static load without visibly settling every frame.
	_warmStartJoints() {

		for ( let j = 0; j < this.jointCount; j ++ ) {

			if ( this.jState[ j ] !== 1 ) continue;

			for ( let r = 0; r < 6; r ++ ) {

				const idx = j * 6 + r;
				let p = this.jPenalty[ idx ] * this.gamma;
				const floor = this.jointPenaltyInit;
				this.jPenalty[ idx ] = p < floor ? floor : ( p > PENALTY_MAX ? PENALTY_MAX : p );
				if ( ! this.postStabilize ) this.jLambda[ idx ] *= this.alpha * this.gamma;

			}

		}

	}

	// q_out = normalize( exp(w dt / 2) * q ) — world-frame angular velocity.
	_integrateQuat( i, dt, ox, oy, oz, ow ) {

		const wx = this.wx[ i ] * dt * 0.5, wy = this.wy[ i ] * dt * 0.5, wz = this.wz[ i ] * dt * 0.5;
		const qx = this.qx[ i ], qy = this.qy[ i ], qz = this.qz[ i ], qw = this.qw[ i ];

		let rx = wx * qw + wy * qz - wz * qy + qx;
		let ry = - wx * qz + wy * qw + wz * qx + qy;
		let rz = wx * qy - wy * qx + wz * qw + qz;
		let rw = - wx * qx - wy * qy - wz * qz + qw;

		const n = Math.sqrt( rx * rx + ry * ry + rz * rz + rw * rw ) || 1;
		ox[ i ] = rx / n; oy[ i ] = ry / n; oz[ i ] = rz / n; ow[ i ] = rw / n;

	}

	_buildContacts() {

		let n = 0;
		const planes = this.planes, boxes = this.boxes;
		const nPlanes = planes.length;
		const margin = COLLISION_MARGIN;
		this._invDt2 = 1 / ( this._dt * this._dt );

		for ( let i = 0; i < this.count; i ++ ) {

			if ( this.state[ i ] !== 1 ) continue;

			const px = this.px[ i ], py = this.py[ i ], pz = this.pz[ i ];
			const qx = this.qx[ i ], qy = this.qy[ i ], qz = this.qz[ i ], qw = this.qw[ i ];
			const rad = this.radius[ i ];
			const hx = this.hx[ i ], hy = this.hy[ i ], hz = this.hz[ i ];

			// Rotation matrix, built once per body per step and cached.
			const xx = qx * qx, yy = qy * qy, zz = qz * qz;
			const xy = qx * qy, xz = qx * qz, yz = qy * qz;
			const wx = qw * qx, wy = qw * qy, wz = qw * qz;
			const m00 = 1 - 2 * ( yy + zz ), m01 = 2 * ( xy - wz ), m02 = 2 * ( xz + wy );
			const m10 = 2 * ( xy + wz ), m11 = 1 - 2 * ( xx + zz ), m12 = 2 * ( yz - wx );
			const m20 = 2 * ( xz - wy ), m21 = 2 * ( yz + wx ), m22 = 1 - 2 * ( xx + yy );

			const r = i * 9;
			this.rot[ r ] = m00; this.rot[ r + 1 ] = m01; this.rot[ r + 2 ] = m02;
			this.rot[ r + 3 ] = m10; this.rot[ r + 4 ] = m11; this.rot[ r + 5 ] = m12;
			this.rot[ r + 6 ] = m20; this.rot[ r + 7 ] = m21; this.rot[ r + 8 ] = m22;

			for ( let c = 0; c < nPlanes; c ++ ) {

				const pl = planes[ c ];
				// Broad phase: the bounding sphere must reach the half-space.
				if ( px * pl.nx + py * pl.ny + pz * pl.nz - pl.d > rad + margin ) continue;

				for ( let k = 0; k < CORNERS; k ++ ) {

					const lx = CORNER_SIGN[ k * 3 ] * hx;
					const ly = CORNER_SIGN[ k * 3 + 1 ] * hy;
					const lz = CORNER_SIGN[ k * 3 + 2 ] * hz;
					const rx = m00 * lx + m01 * ly + m02 * lz;
					const ry = m10 * lx + m11 * ly + m12 * lz;
					const rz = m20 * lx + m21 * ly + m22 * lz;
					const C = ( px + rx ) * pl.nx + ( py + ry ) * pl.ny + ( pz + rz ) * pl.nz - pl.d;

					if ( C > margin ) continue;
					if ( n >= this._contactCap ) { this.numContacts = n; return; }

					n = this._emitStatic( n, i, k, c, pl.nx, pl.ny, pl.nz, pl.d,
						lx, ly, lz, rx, ry, rz, px, py, pz, pl.friction );

				}

			}

			for ( let bi = 0; bi < boxes.length; bi ++ ) {

				const bx = boxes[ bi ];
				const c = nPlanes + bi;

				if ( Math.abs( px - bx.cx ) > bx.hx + rad + margin ) continue;
				if ( Math.abs( py - bx.cy ) > bx.hy + rad + margin ) continue;
				if ( Math.abs( pz - bx.cz ) > bx.hz + rad + margin ) continue;

				for ( let k = 0; k < CORNERS; k ++ ) {

					const lx = CORNER_SIGN[ k * 3 ] * hx;
					const ly = CORNER_SIGN[ k * 3 + 1 ] * hy;
					const lz = CORNER_SIGN[ k * 3 + 2 ] * hz;
					const rx = m00 * lx + m01 * ly + m02 * lz;
					const ry = m10 * lx + m11 * ly + m12 * lz;
					const rz = m20 * lx + m21 * ly + m22 * lz;
					const wxp = px + rx, wyp = py + ry, wzp = pz + rz;

					const dx = wxp - bx.cx, dy = wyp - bx.cy, dz = wzp - bx.cz;
					const ox = bx.hx - Math.abs( dx );
					const oy = bx.hy - Math.abs( dy );
					const oz = bx.hz - Math.abs( dz );
					if ( ox <= 0 || oy <= 0 || oz <= 0 ) continue;

					// Deepest corner leaves along the axis of least penetration.
					let nx = 0, ny = 0, nz = 0, depth;

					if ( ox <= oy && ox <= oz ) { nx = Math.sign( dx ) || 1; depth = ox; }
					else if ( oy <= oz ) { ny = Math.sign( dy ) || 1; depth = oy; }
					else { nz = Math.sign( dz ) || 1; depth = oz; }

					const d = ( bx.cx + nx * bx.hx ) * nx + ( bx.cy + ny * bx.hy ) * ny + ( bx.cz + nz * bx.hz ) * nz;
					if ( n >= this._contactCap ) { this.numContacts = n; return; }

					n = this._emitStatic( n, i, k, c, nx, ny, nz, d,
						lx, ly, lz, rx, ry, rz, px, py, pz, bx.friction );

				}

			}

		}

		n = this._buildPairContacts( n );
		this.numContacts = n;
		this.stats.contacts = n;

	}

	_emitStatic( n, i, corner, collider, nx, ny, nz, d, lx, ly, lz, rx, ry, rz, px, py, pz, friction ) {

		const slot = ( i * CORNERS + corner ) * MAX_COLLIDERS + collider;

		this.cBody[ n ] = i;
		this.cBodyB[ n ] = - 1;
		this.cSlot[ n ] = slot;
		this.cNx[ n ] = nx; this.cNy[ n ] = ny; this.cNz[ n ] = nz;
		this.cPlaneD[ n ] = d;
		this.cLax[ n ] = lx; this.cLay[ n ] = ly; this.cLaz[ n ] = lz;
		this.cRax[ n ] = rx; this.cRay[ n ] = ry; this.cRaz[ n ] = rz;
		this.cFriction[ n ] = friction * this.friction[ i ];

		// Orthonormal tangent basis, branch-free (Duff et al.).
		const s = nz >= 0 ? 1 : - 1;
		const a = - 1 / ( s + nz );
		const b = nx * ny * a;
		this.cT1x[ n ] = 1 + s * nx * nx * a; this.cT1y[ n ] = s * b; this.cT1z[ n ] = - s * nx;
		this.cT2x[ n ] = b; this.cT2y[ n ] = s + ny * ny * a; this.cT2z[ n ] = - ny;

		// Friction anchor: where the corner first touched. Static friction is
		// then "return to the anchor", which is what makes chunks stop dead on
		// tile instead of creeping.
		if ( this.anchorLive[ slot ] === 0 ) {

			this.anchorX[ slot ] = px + rx; this.anchorY[ slot ] = py + ry; this.anchorZ[ slot ] = pz + rz;
			this.anchorLive[ slot ] = 1;

		}

		this.cAnchorX[ n ] = this.anchorX[ slot ];
		this.cAnchorY[ n ] = this.anchorY[ slot ];
		this.cAnchorZ[ n ] = this.anchorZ[ slot ];

		// Warm start from the previous step (Eq. 19). With post-stabilisation the
		// full lambda carries over and only the penalty decays.
		// Floor the penalty at the body's own inertia over the step. A contact
		// seeded at 1.0 produces a force of about a newton on its first iteration,
		// which is why a fast body sails straight through a wall: the penalty ramp
		// never catches up inside one step's iteration budget. Scaling the seed by
		// M/dt^2 makes the constraint competitive with inertia from the start, and
		// it is unit-free — it works the same for a 10kg paver and a tonne bench.
		const seed = this.mass[ i ] * this._invDt2;

		for ( let r = 0; r < ROWS; r ++ ) {

			const src = slot * ROWS + r;
			let pen = this.penalty[ src ] * this.gamma;
			if ( pen < seed ) pen = seed;
			pen = pen < PENALTY_MIN ? PENALTY_MIN : ( pen > PENALTY_MAX ? PENALTY_MAX : pen );
			this.penalty[ src ] = pen;
			this.cPenalty[ n * ROWS + r ] = pen;
			this.cLambda[ n * ROWS + r ] = this.postStabilize
				? this.lambda[ src ]
				: this.lambda[ src ] * this.alpha * this.gamma;

		}

		return n + 1;

	}

	// Closest point on body i's box to a world point, written to `out`. This is
	// the whole trick that makes pair contacts read as boxes rather than as
	// spheres: clamp into the local frame, transform back out.
	_closestOnBox( i, wx, wy, wz, out ) {

		const r = i * 9;
		const dx = wx - this.px[ i ], dy = wy - this.py[ i ], dz = wz - this.pz[ i ];

		// R^T * d — the transpose, because R is orthonormal.
		let lx = this.rot[ r ] * dx + this.rot[ r + 3 ] * dy + this.rot[ r + 6 ] * dz;
		let ly = this.rot[ r + 1 ] * dx + this.rot[ r + 4 ] * dy + this.rot[ r + 7 ] * dz;
		let lz = this.rot[ r + 2 ] * dx + this.rot[ r + 5 ] * dy + this.rot[ r + 8 ] * dz;

		const hx = this.hx[ i ], hy = this.hy[ i ], hz = this.hz[ i ];
		lx = lx < - hx ? - hx : ( lx > hx ? hx : lx );
		ly = ly < - hy ? - hy : ( ly > hy ? hy : ly );
		lz = lz < - hz ? - hz : ( lz > hz ? hz : lz );

		out[ 0 ] = this.px[ i ] + this.rot[ r ] * lx + this.rot[ r + 1 ] * ly + this.rot[ r + 2 ] * lz;
		out[ 1 ] = this.py[ i ] + this.rot[ r + 3 ] * lx + this.rot[ r + 4 ] * ly + this.rot[ r + 5 ] * lz;
		out[ 2 ] = this.pz[ i ] + this.rot[ r + 6 ] * lx + this.rot[ r + 7 ] * ly + this.rot[ r + 8 ] * lz;

	}

	// Chunk-vs-chunk.
	//
	// Bounding spheres were the obvious cheap answer and they are wrong for
	// anything elongated: a 1.8m bench has a 0.94m bounding sphere, so it
	// phantom-collides with everything within a metre of it and the penalty ramp
	// launches both bodies. Instead, alternate closest-point queries between the
	// two boxes — two rounds converge for the shallow contacts that matter, gives
	// a real surface contact point, and therefore a real lever arm.
	//
	// Deep overlap (only really produced by spawning bodies inside each other)
	// degenerates to zero distance; that case falls back to the centre-difference
	// normal, which is stable if not accurate.
	//
	// Not warm-started: debris pairs rarely persist long enough to pay for the
	// bookkeeping, and the static contacts are what hold a pile up.
	_buildPairContacts( n ) {

		// Must exceed the largest combined reach of any two bodies in the scene,
		// or the 27-cell neighbourhood stops being sufficient.
		const cell = 2.0;
		const margin = COLLISION_MARGIN;
		// Generate contacts slightly before touching. A speculative row costs
		// nothing — its normal force clamps to zero at positive gap — and it lets
		// the penalty warm up before the surfaces actually meet.
		const skin = COLLISION_MARGIN * 2;
		const cpA = this._cpA || ( this._cpA = new Float32Array( 3 ) );
		const cpB = this._cpB || ( this._cpB = new Float32Array( 3 ) );
		const grid = this._grid || ( this._grid = new Map() );
		grid.clear();

		const hash = ( x, y, z ) => ( x * 73856093 ) ^ ( y * 19349663 ) ^ ( z * 83492791 );

		// Sleeping bodies go in too. They are skipped by the primal sweep, so they
		// behave as immovable — but leaving them out of the broadphase entirely
		// makes every settled object a ghost that anything can fly through, which
		// is the same failure as the missing-neighbour bug above and much easier
		// to mistake for correct behaviour.
		for ( let i = 0; i < this.count; i ++ ) {

			if ( this.state[ i ] === 0 ) continue;
			const key = hash(
				Math.floor( this.px[ i ] / cell ),
				Math.floor( this.py[ i ] / cell ),
				Math.floor( this.pz[ i ] / cell )
			);
			let list = grid.get( key );
			if ( list === undefined ) { list = []; grid.set( key, list ); }
			list.push( i );

		}

		// Scan the 3x3x3 neighbourhood, not just the home cell. Testing only
		// same-cell pairs silently drops every contact that straddles a boundary —
		// roughly half of them — and the failure looks exactly like objects
		// passing through each other at random. Cell size is set above the largest
		// combined reach in the scene so 27 cells is provably sufficient.
		for ( let i = 0; i < this.count; i ++ ) {

			if ( this.state[ i ] === 0 ) continue;

			// Only the cells this body can actually reach — its own radius plus the
			// largest radius in the scene. A blanket 3x3x3 scan is correct but does
			// roughly three times the lookups, and for the small chunks that make up
			// most of a debris field the real span is two cells per axis, not three.
			const reach = this.radius[ i ] + this._maxRadius + margin;
			const lox = Math.floor( ( this.px[ i ] - reach ) / cell );
			const hix = Math.floor( ( this.px[ i ] + reach ) / cell );
			const loy = Math.floor( ( this.py[ i ] - reach ) / cell );
			const hiy = Math.floor( ( this.py[ i ] + reach ) / cell );
			const loz = Math.floor( ( this.pz[ i ] - reach ) / cell );
			const hiz = Math.floor( ( this.pz[ i ] + reach ) / cell );

			for ( let ox = lox; ox <= hix; ox ++ ) {

				for ( let oy = loy; oy <= hiy; oy ++ ) {

					for ( let oz = loz; oz <= hiz; oz ++ ) {

						const list = grid.get( hash( ox, oy, oz ) );
						if ( list === undefined ) continue;

						for ( let b = 0; b < list.length; b ++ ) {

							const j = list[ b ];
							// Each pair is generated once, by its lower index.
							if ( j <= i ) continue;

					// Two sleepers cannot move, so there is nothing to solve.
					if ( this.state[ i ] === 2 && this.state[ j ] === 2 ) continue;

					if ( this.jointPairs.size > 0 && this.jointPairs.has( this._pairKey( i, j ) ) ) continue;

					// Broad phase still uses bounding spheres — cheap and only
					// ever rejects, never accepts.
					const cx = this.px[ j ] - this.px[ i ];
					const cy = this.py[ j ] - this.py[ i ];
					const cz = this.pz[ j ] - this.pz[ i ];
					const reach = this.radius[ i ] + this.radius[ j ] + margin;
					if ( cx * cx + cy * cy + cz * cz >= reach * reach ) continue;
					if ( n >= this._contactCap ) return n;

					// Alternating closest points, two rounds.
					this._closestOnBox( i, this.px[ j ], this.py[ j ], this.pz[ j ], cpA );
					this._closestOnBox( j, cpA[ 0 ], cpA[ 1 ], cpA[ 2 ], cpB );
					this._closestOnBox( i, cpB[ 0 ], cpB[ 1 ], cpB[ 2 ], cpA );

					let dx = cpB[ 0 ] - cpA[ 0 ];
					let dy = cpB[ 1 ] - cpA[ 1 ];
					let dz = cpB[ 2 ] - cpA[ 2 ];
					let dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

					// Separated by more than the skin: nothing to do.
					if ( dist > skin ) continue;

					let nx, ny, nz;

					if ( dist > 1e-6 ) {

						nx = dx / dist; ny = dy / dist; nz = dz / dist;

						// The closest-point pair cannot tell touching from
						// interpenetrating, so decide with the centre offset:
						// if the surfaces face away from the other body's centre,
						// they have passed through each other.
						if ( nx * cx + ny * cy + nz * cz < 0 ) { nx = - nx; ny = - ny; nz = - nz; dist = - dist; }

					} else {

						const cl = Math.sqrt( cx * cx + cy * cy + cz * cz );
						if ( cl < 1e-6 ) continue;
						nx = cx / cl; ny = cy / cl; nz = cz / cl;
						dist = 0;

					}

					const ra1 = cpA[ 0 ] - this.px[ i ], ra2 = cpA[ 1 ] - this.py[ i ], ra3 = cpA[ 2 ] - this.pz[ i ];
					const rb1 = cpB[ 0 ] - this.px[ j ], rb2 = cpB[ 1 ] - this.py[ j ], rb3 = cpB[ 2 ] - this.pz[ j ];

					this.cBody[ n ] = i;
					this.cBodyB[ n ] = j;
					this.cSlot[ n ] = - 1;
					// Normal points from j toward i, i.e. the direction i is pushed.
					this.cNx[ n ] = - nx; this.cNy[ n ] = - ny; this.cNz[ n ] = - nz;
					this.cPlaneD[ n ] = 0;   // unused for pair contacts
					this.cRax[ n ] = ra1; this.cRay[ n ] = ra2; this.cRaz[ n ] = ra3;
					this.cRbx[ n ] = rb1; this.cRby[ n ] = rb2; this.cRbz[ n ] = rb3;
					this.cFriction[ n ] = this.friction[ i ] * this.friction[ j ];

					// Anchor at the contact point so the friction rows start at
					// zero error. Without this they inherit whatever the previous
					// occupant of this contact slot left behind and shove.
					this.cAnchorX[ n ] = cpA[ 0 ];
					this.cAnchorY[ n ] = cpA[ 1 ];
					this.cAnchorZ[ n ] = cpA[ 2 ];

					// A sleeper only wakes for something with real closing speed,
					// so a settled pile is not roused by its own residual jitter.
					if ( this.state[ i ] === 2 || this.state[ j ] === 2 ) {

						const rvx = this.vx[ j ] - this.vx[ i ];
						const rvy = this.vy[ j ] - this.vy[ i ];
						const rvz = this.vz[ j ] - this.vz[ i ];

						if ( rvx * nx + rvy * ny + rvz * nz < - this.sleepLinear * 3 ) {

							this.wake( i ); this.wake( j );

						}

					}

					const s = nz >= 0 ? 1 : - 1;
					const aa = - 1 / ( s + nz );
					const bb = nx * ny * aa;
					this.cT1x[ n ] = 1 + s * nx * nx * aa; this.cT1y[ n ] = s * bb; this.cT1z[ n ] = - s * nx;
					this.cT2x[ n ] = bb; this.cT2y[ n ] = s + ny * ny * aa; this.cT2z[ n ] = - ny;

					// Reduced mass, because both ends of a pair contact move.
					const mi = this.mass[ i ], mj = this.mass[ j ];
					const pseed = ( mi * mj / ( mi + mj ) ) * this._invDt2;

					for ( let r = 0; r < ROWS; r ++ ) {

						this.cLambda[ n * ROWS + r ] = 0;
						this.cPenalty[ n * ROWS + r ] = pseed;

					}

					n ++;

						}

					}

				}

			}

		}

		return n;

	}

	// CSR adjacency so the primal sweep touches only the contacts on each body.
	_buildAdjacency() {

		const counts = this.bodyContactStart;
		counts.fill( 0 );

		for ( let c = 0; c < this.numContacts; c ++ ) {

			counts[ this.cBody[ c ] + 1 ] ++;
			const j = this.cBodyB[ c ];
			if ( j >= 0 ) counts[ j + 1 ] ++;

		}

		for ( let i = 0; i < this.maxBodies; i ++ ) counts[ i + 1 ] += counts[ i ];

		const cursor = this._cursor || ( this._cursor = new Int32Array( this.maxBodies ) );
		cursor.set( counts.subarray( 0, this.maxBodies ) );

		for ( let c = 0; c < this.numContacts; c ++ ) {

			this.bodyContactList[ cursor[ this.cBody[ c ] ] ++ ] = c;
			const j = this.cBodyB[ c ];
			if ( j >= 0 ) this.bodyContactList[ cursor[ j ] ++ ] = ~ c;   // ~c marks "I am body B"

		}

	}

	// Evaluate contact row values for the current primal state.
	_evalContact( c, alpha ) {

		const i = this.cBody[ c ];
		const j = this.cBodyB[ c ];
		const nx = this.cNx[ c ], ny = this.cNy[ c ], nz = this.cNz[ c ];
		let wx, wy, wz, Cn;

		if ( j < 0 ) {

			// Re-rotate the stored local corner so the constraint tracks the body
			// as it turns during the sweep.
			const qx = this.qx[ i ], qy = this.qy[ i ], qz = this.qz[ i ], qw = this.qw[ i ];
			const lx = this.cLax[ c ], ly = this.cLay[ c ], lz = this.cLaz[ c ];
			const tx = 2 * ( qy * lz - qz * ly );
			const ty = 2 * ( qz * lx - qx * lz );
			const tz = 2 * ( qx * ly - qy * lx );
			const rx = lx + qw * tx + qy * tz - qz * ty;
			const ry = ly + qw * ty + qz * tx - qx * tz;
			const rz = lz + qw * tz + qx * ty - qy * tx;
			this.cRax[ c ] = rx; this.cRay[ c ] = ry; this.cRaz[ c ] = rz;

			wx = this.px[ i ] + rx; wy = this.py[ i ] + ry; wz = this.pz[ i ] + rz;
			Cn = wx * nx + wy * ny + wz * nz - this.cPlaneD[ c ];

		} else {

			// Gap along the contact normal between the two surface points, which
			// ride along with their bodies on fixed world-space lever arms. Not
			// re-derived per iteration — over six iterations the bodies barely
			// move, and re-running closest-points inside the sweep would cost more
			// than it buys.
			wx = this.px[ i ] + this.cRax[ c ];
			wy = this.py[ i ] + this.cRay[ c ];
			wz = this.pz[ i ] + this.cRaz[ c ];

			const sx = this.px[ j ] + this.cRbx[ c ] - wx;
			const sy = this.py[ j ] + this.cRby[ c ] - wy;
			const sz = this.pz[ j ] + this.cRbz[ c ] - wz;

			Cn = - ( sx * nx + sy * ny + sz * nz );

		}

		const base = c * ROWS;
		this.cC[ base ] = Cn * alpha;

		const ax = wx - this.cAnchorX[ c ], ay = wy - this.cAnchorY[ c ], az = wz - this.cAnchorZ[ c ];
		this.cC[ base + 1 ] = ( ax * this.cT1x[ c ] + ay * this.cT1y[ c ] + az * this.cT1z[ c ] ) * alpha;
		this.cC[ base + 2 ] = ( ax * this.cT2x[ c ] + ay * this.cT2y[ c ] + az * this.cT2z[ c ] ) * alpha;

	}

	_primalUpdate( invDt2, alpha ) {

		const a = this._a, aA = this._b, out = this._out, outA = this._out2;

		for ( let i = 0; i < this.count; i ++ ) {

			if ( this.state[ i ] !== 1 ) continue;

			const m = this.mass[ i ] * invDt2;
			const I = this.inertia[ i ] * invDt2;

			// Linear block (Eqs. 5, 6): M/dt^2 pulling toward the inertial position.
			a[ 0 ] = m; a[ 1 ] = 0; a[ 2 ] = 0; a[ 3 ] = m; a[ 4 ] = 0; a[ 5 ] = m;
			let b0 = m * ( this.px[ i ] - this.nx[ i ] );
			let b1 = m * ( this.py[ i ] - this.ny[ i ] );
			let b2 = m * ( this.pz[ i ] - this.nz[ i ] );

			// Angular block. The residual is the world-frame rotation vector from
			// the inertial orientation to the current one.
			const e = this._rotError( i );
			aA[ 0 ] = I; aA[ 1 ] = 0; aA[ 2 ] = 0; aA[ 3 ] = I; aA[ 4 ] = 0; aA[ 5 ] = I;
			let c0 = I * e[ 0 ], c1 = I * e[ 1 ], c2 = I * e[ 2 ];

			const start = this.bodyContactStart[ i ], end = this.bodyContactStart[ i + 1 ];

			for ( let k = start; k < end; k ++ ) {

				const enc = this.bodyContactList[ k ];
				const isB = enc < 0;
				const c = isB ? ~ enc : enc;

				this._evalContact( c, alpha );

				const sgn = isB ? - 1 : 1;
				const rx = isB ? this.cRbx[ c ] : this.cRax[ c ];
				const ry = isB ? this.cRby[ c ] : this.cRay[ c ];
				const rz = isB ? this.cRbz[ c ] : this.cRaz[ c ];

				const base = c * ROWS;
				const lamN = this.cLambda[ base ];
				const fN = this.cPenalty[ base ] * this.cC[ base ] + lamN;
				const clampedN = fN > 0 ? 0 : fN;   // fmin = -inf, fmax = 0 (push apart only)
				const muN = this.cFriction[ c ] * Math.abs( clampedN );

				for ( let r = 0; r < ROWS; r ++ ) {

					const idx = base + r;
					const pen = this.cPenalty[ idx ];
					let f = pen * this.cC[ idx ] + this.cLambda[ idx ];

					if ( r === 0 ) { f = f > 0 ? 0 : f; }
					else { f = f > muN ? muN : ( f < - muN ? - muN : f ); }

					if ( f === 0 && r !== 0 ) continue;

					const dx = r === 0 ? this.cNx[ c ] : ( r === 1 ? this.cT1x[ c ] : this.cT2x[ c ] );
					const dy = r === 0 ? this.cNy[ c ] : ( r === 1 ? this.cT1y[ c ] : this.cT2y[ c ] );
					const dz = r === 0 ? this.cNz[ c ] : ( r === 1 ? this.cT1z[ c ] : this.cT2z[ c ] );

					const jx = dx * sgn, jy = dy * sgn, jz = dz * sgn;
					const kx = ry * jz - rz * jy;
					const ky = rz * jx - rx * jz;
					const kz = rx * jy - ry * jx;

					// Accumulate force (Eq. 13) and Hessian (Eq. 17).
					b0 += jx * f; b1 += jy * f; b2 += jz * f;
					c0 += kx * f; c1 += ky * f; c2 += kz * f;

					a[ 0 ] += jx * jx * pen; a[ 1 ] += jx * jy * pen; a[ 2 ] += jx * jz * pen;
					a[ 3 ] += jy * jy * pen; a[ 4 ] += jy * jz * pen; a[ 5 ] += jz * jz * pen;

					aA[ 0 ] += kx * kx * pen; aA[ 1 ] += kx * ky * pen; aA[ 2 ] += kx * kz * pen;
					aA[ 3 ] += ky * ky * pen; aA[ 4 ] += ky * kz * pen; aA[ 5 ] += kz * kz * pen;

					// Diagonally lumped geometric stiffness (Sec. 3.5). The linear
					// block has no second derivative; the angular one scales with
					// the lever arm, and without it long arms go unstable.
					const G = Math.abs( f ) * Math.sqrt( rx * rx + ry * ry + rz * rz );
					aA[ 0 ] += G; aA[ 3 ] += G; aA[ 5 ] += G;

				}

			}

			// Joints. Bilateral and unclamped, so unlike a contact these can pull
			// as well as push — which is the entire point: a weld holds a chunk
			// up against gravity, and how hard it is pulling is the number that
			// decides whether it lets go.
			const js = this.bodyJointStart[ i ], je = this.bodyJointStart[ i + 1 ];

			for ( let k = js; k < je; k ++ ) {

				const enc = this.bodyJointList[ k ];
				const isB = enc < 0;
				const j = isB ? ~ enc : enc;

				this._evalJoint( j, alpha );

				const sgn = isB ? - 1 : 1;
				const rx = isB ? this.jRbx[ j ] : this.jRax[ j ];
				const ry = isB ? this.jRby[ j ] : this.jRay[ j ];
				const rz = isB ? this.jRbz[ j ] : this.jRaz[ j ];
				const rlen = Math.sqrt( rx * rx + ry * ry + rz * rz );
				const base = j * 6;

				// Linear rows: axis-aligned, so J_lin is a unit basis vector and
				// J_ang is r x e_k. One diagonal entry each in the linear block.
				for ( let r = 0; r < 3; r ++ ) {

					const idx = base + r;
					const pen = this.jPenalty[ idx ];
					const f = pen * this.jC[ idx ] + this.jLambda[ idx ];

					let kx, ky, kz;
					if ( r === 0 ) { kx = 0; ky = rz; kz = - ry; }
					else if ( r === 1 ) { kx = - rz; ky = 0; kz = rx; }
					else { kx = ry; ky = - rx; kz = 0; }

					kx *= sgn; ky *= sgn; kz *= sgn;

					if ( r === 0 ) { b0 += sgn * f; a[ 0 ] += pen; }
					else if ( r === 1 ) { b1 += sgn * f; a[ 3 ] += pen; }
					else { b2 += sgn * f; a[ 5 ] += pen; }

					c0 += kx * f; c1 += ky * f; c2 += kz * f;

					aA[ 0 ] += kx * kx * pen; aA[ 1 ] += kx * ky * pen; aA[ 2 ] += kx * kz * pen;
					aA[ 3 ] += ky * ky * pen; aA[ 4 ] += ky * kz * pen; aA[ 5 ] += kz * kz * pen;

					const G = Math.abs( f ) * rlen;
					aA[ 0 ] += G; aA[ 3 ] += G; aA[ 5 ] += G;

				}

				// Angular rows: J_ang is a unit basis vector, J_lin is zero.
				for ( let r = 3; r < 6; r ++ ) {

					const idx = base + r;
					const pen = this.jPenalty[ idx ];
					const f = pen * this.jC[ idx ] + this.jLambda[ idx ];

					if ( r === 3 ) { c0 += sgn * f; aA[ 0 ] += pen; }
					else if ( r === 4 ) { c1 += sgn * f; aA[ 3 ] += pen; }
					else { c2 += sgn * f; aA[ 5 ] += pen; }

				}

			}

			solveSPD3( a, b0, b1, b2, out );
			this.px[ i ] -= out[ 0 ]; this.py[ i ] -= out[ 1 ]; this.pz[ i ] -= out[ 2 ];

			solveSPD3( aA, c0, c1, c2, outA );
			this._applyRotation( i, - outA[ 0 ], - outA[ 1 ], - outA[ 2 ] );

		}

	}

	_rotError( i ) {

		const e = this._rotErr || ( this._rotErr = new Float32Array( 3 ) );
		// r = q * conj(q_inertial), then the rotation vector 2 * vec(r) for small angles.
		const ax = this.qx[ i ], ay = this.qy[ i ], az = this.qz[ i ], aw = this.qw[ i ];
		const bx = - this.nqx[ i ], by = - this.nqy[ i ], bz = - this.nqz[ i ], bw = this.nqw[ i ];

		let rx = aw * bx + ax * bw + ay * bz - az * by;
		let ry = aw * by - ax * bz + ay * bw + az * bx;
		let rz = aw * bz + ax * by - ay * bx + az * bw;
		const rw = aw * bw - ax * bx - ay * by - az * bz;

		const s = rw < 0 ? - 2 : 2;   // shortest arc
		e[ 0 ] = rx * s; e[ 1 ] = ry * s; e[ 2 ] = rz * s;
		return e;

	}

	_applyRotation( i, dx, dy, dz ) {

		const hx = dx * 0.5, hy = dy * 0.5, hz = dz * 0.5;
		const qx = this.qx[ i ], qy = this.qy[ i ], qz = this.qz[ i ], qw = this.qw[ i ];

		let rx = hx * qw + hy * qz - hz * qy + qx;
		let ry = - hx * qz + hy * qw + hz * qx + qy;
		let rz = hx * qy - hy * qx + hz * qw + qz;
		let rw = - hx * qx - hy * qy - hz * qz + qw;

		const n = Math.sqrt( rx * rx + ry * ry + rz * rz + rw * rw ) || 1;
		this.qx[ i ] = rx / n; this.qy[ i ] = ry / n; this.qz[ i ] = rz / n; this.qw[ i ] = rw / n;

	}

	_dualUpdate( alpha ) {

		for ( let c = 0; c < this.numContacts; c ++ ) {

			this._evalContact( c, alpha );

			const base = c * ROWS;
			const lamN = this.cPenalty[ base ] * this.cC[ base ] + this.cLambda[ base ];
			const clampedN = lamN > 0 ? 0 : lamN;
			this.cLambda[ base ] = clampedN;
			const muN = this.cFriction[ c ] * Math.abs( clampedN );

			for ( let r = 0; r < ROWS; r ++ ) {

				const idx = base + r;

				if ( r > 0 ) {

					let l = this.cPenalty[ idx ] * this.cC[ idx ] + this.cLambda[ idx ];
					this.cLambda[ idx ] = l > muN ? muN : ( l < - muN ? - muN : l );

				}

				// Penalty ramp (Eq. 16), only while the row is interior to its bounds.
				const l = this.cLambda[ idx ];
				const lo = r === 0 ? - Infinity : - muN;
				const hi = r === 0 ? 0 : muN;

				if ( l > lo && l < hi ) {

					const p = this.cPenalty[ idx ] + this.beta * Math.abs( this.cC[ idx ] );
					this.cPenalty[ idx ] = p > PENALTY_MAX ? PENALTY_MAX : p;

				}

			}

		}

	}

	_computeVelocities( invDt ) {

		for ( let i = 0; i < this.count; i ++ ) {

			if ( this.state[ i ] !== 1 ) continue;

			this.pvx[ i ] = this.vx[ i ];
			this.pvy[ i ] = this.vy[ i ];
			this.pvz[ i ] = this.vz[ i ];
			this.vx[ i ] = ( this.px[ i ] - this.ix[ i ] ) * invDt;
			this.vy[ i ] = ( this.py[ i ] - this.iy[ i ] ) * invDt;
			this.vz[ i ] = ( this.pz[ i ] - this.iz[ i ] ) * invDt;

			// Angular velocity from the orientation delta over the step (BDF1).
			const ax = this.qx[ i ], ay = this.qy[ i ], az = this.qz[ i ], aw = this.qw[ i ];
			const bx = - this.iqx[ i ], by = - this.iqy[ i ], bz = - this.iqz[ i ], bw = this.iqw[ i ];
			const rx = aw * bx + ax * bw + ay * bz - az * by;
			const ry = aw * by - ax * bz + ay * bw + az * bx;
			const rz = aw * bz + ax * by - ay * bx + az * bw;
			const rw = aw * bw - ax * bx - ay * by - az * bz;
			const s = ( rw < 0 ? - 2 : 2 ) * invDt;

			this.wx[ i ] = rx * s; this.wy[ i ] = ry * s; this.wz[ i ] = rz * s;

		}

	}

	_finish( dt ) {

		// Persist duals and clear stale friction anchors.
		for ( let c = 0; c < this.numContacts; c ++ ) {

			const slot = this.cSlot[ c ];
			if ( slot < 0 ) continue;

			for ( let r = 0; r < ROWS; r ++ ) {

				this.lambda[ slot * ROWS + r ] = this.cLambda[ c * ROWS + r ];
				this.penalty[ slot * ROWS + r ] = this.cPenalty[ c * ROWS + r ];

			}

			// Sliding: if the tangential force saturated, the corner is not stuck,
			// so drag the anchor along to where it actually is.
			const base = c * ROWS;
			const muN = this.cFriction[ c ] * Math.abs( this.cLambda[ base ] );

			if ( Math.abs( this.cLambda[ base + 1 ] ) >= muN * 0.999 ||
				Math.abs( this.cLambda[ base + 2 ] ) >= muN * 0.999 ) {

				const i = this.cBody[ c ];
				this.anchorX[ slot ] = this.px[ i ] + this.cRax[ c ];
				this.anchorY[ slot ] = this.py[ i ] + this.cRay[ c ];
				this.anchorZ[ slot ] = this.pz[ i ] + this.cRaz[ c ];

			}

		}

		let active = 0, asleep = 0;

		for ( let i = 0; i < this.count; i ++ ) {

			if ( this.state[ i ] === 0 ) continue;

			if ( this.state[ i ] === 2 ) { asleep ++; this.age[ i ] += dt; continue; }

			active ++;

			// Impact reporting: the change in velocity across the step is exactly
			// the impulse the contacts applied, which is the right quantity to
			// hear (§23.6). Gravity's own contribution is subtracted so a body in
			// free fall is silent.
			if ( this.onImpact !== null ) {

				const dvx = this.vx[ i ] - this.pvx[ i ];
				const dvy = this.vy[ i ] - this.pvy[ i ] - this.gravity * dt;
				const dvz = this.vz[ i ] - this.pvz[ i ];
				const speed = Math.sqrt( dvx * dvx + dvy * dvy + dvz * dvz );

				if ( speed > 1.2 ) {

					this.onImpact( i, speed, this.px[ i ], this.py[ i ], this.pz[ i ], this.material[ i ] );

				}

			}

			const v2 = this.vx[ i ] * this.vx[ i ] + this.vy[ i ] * this.vy[ i ] + this.vz[ i ] * this.vz[ i ];
			const w2 = this.wx[ i ] * this.wx[ i ] + this.wy[ i ] * this.wy[ i ] + this.wz[ i ] * this.wz[ i ];

			if ( v2 < this.sleepLinear * this.sleepLinear && w2 < this.sleepAngular * this.sleepAngular ) {

				this.restTimer[ i ] += dt;

				if ( this.restTimer[ i ] > this.sleepTime ) {

					this.state[ i ] = 2;
					this.vx[ i ] = 0; this.vy[ i ] = 0; this.vz[ i ] = 0;
					this.wx[ i ] = 0; this.wy[ i ] = 0; this.wz[ i ] = 0;

				}

			} else {

				this.restTimer[ i ] = 0;

			}

		}

		this.stats.active = active;
		this.stats.asleep = asleep;

	}

}

export { PENALTY_MIN, PENALTY_MAX, CORNER_SIGN };
