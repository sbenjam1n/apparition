// Authored destruction, held together by a joint graph.
//
// The chunk set is still hand-made and discrete (§7.4) — no runtime fracture, no
// Voronoi, a fixed grid per panel. What changed is that the chunks are welded to
// each other and to the frame instead of all detaching at once. Hit a panel and
// only the joints near the impact exceed their fracture load, so three chunks
// drop out and leave a ragged hole with the rest still standing. Hit it somewhere
// else and you get a different hole.
//
// Three things fall out of that, all of which the design index already wanted:
//
//   * §32.3, Siege's rule. Collapse is connectivity, not simulation: a piece
//     that loses its path to the frame falls, anything still attached stays.
//     Union-find over the surviving joints, microseconds, no structural solver.
//   * §45.5, the delayed shred. Joints creep above yield and let go seconds
//     later, so an overloaded panel sags and then drops rather than popping.
//     Under dilation those seconds are a very long time.
//   * §31.3 survives, provided you enumerate the right thing. Verification cares
//     about *aperture topology* — is there a hole the player fits through — not
//     about which of 2^93 joint subsets survived. Three states per panel stay
//     exhaustively checkable with the lattice as cosmetic detail underneath.
//     That is the constraint that would otherwise have died quietly here.
//
// §7.2 still holds: breaking a wall must be hard, and nothing else in the room
// can be broken at all.

import * as THREE from 'three';
import { createSurfaceMaterial } from './materials.js';
import { MATERIAL_KIND } from './room.js';

// Aperture states. Not damage tiers — these are the topological facts the
// verification pass enumerates over.
export const PANEL_STATE = { INTACT: 0, BREACHED: 1, OPEN: 2 };
export const PANEL_STATE_NAME = [ 'INTACT', 'BREACHED', 'OPEN' ];

// Energy needed to convert a panel from one static mesh into a live lattice.
// Below this it costs nothing at all.
const DAMAGE_PER_JOULE = 0.03;
const ACTIVATION_THRESHOLD = 110;

// A chunk counts as "out" of the wall once it has travelled this fraction of a
// cell from where it was authored. Geometric, so a chunk that broke free but is
// still sitting in its socket correctly does not read as a hole.
const OPEN_FRACTION = 0.45;

const _p = new THREE.Vector3();
const _d = new THREE.Vector3();

class WeakPanel {

	constructor( scene, rig, spec, id ) {

		this.id = id;
		this.spec = spec;
		this.state = PANEL_STATE.INTACT;
		this.damage = 0;
		this.activated = false;

		const { cx, cy, cz, hx, hy, hz } = spec;
		this.center = new THREE.Vector3( cx, cy, cz );
		this.half = new THREE.Vector3( hx, hy, hz );
		this.normal = spec.normal;

		this.cols = spec.cols ?? 6;
		this.rows = spec.rows ?? 7;

		// Panel-local axes: `u` runs across the face, `v` runs up it, and the
		// normal is the thickness. Everything below is authored in that frame so
		// the same code builds a wall panel and a ceiling panel.
		this.axisU = Math.abs( this.normal.x ) > 0.5
			? new THREE.Vector3( 0, 0, 1 )
			: new THREE.Vector3( 1, 0, 0 );
		this.axisV = new THREE.Vector3( 0, 1, 0 );

		this.halfU = Math.abs( this.normal.x ) > 0.5 ? hz : hx;
		this.halfV = hy;
		this.halfN = Math.abs( this.normal.x ) > 0.5 ? hx : hz;

		this.cellU = this.halfU / this.cols;   // half-extent of one cell
		this.cellV = this.halfV / this.rows;

		this.chunks = new Int32Array( this.cols * this.rows ).fill( - 1 );
		this.rest = new Float32Array( this.cols * this.rows * 3 );
		this.open = new Uint8Array( this.cols * this.rows );
		this.joints = [];

		this.material = createSurfaceMaterial( rig, {
			tileScale: 3.4,
			groutWidth: 1.6,
			upper: 0x9aa39c,
			lower: 0x141a1c,
			grout: 0x1a1004,
			wainscot: spec.wainscot ?? 2.6,
			wainscotBlend: 0.05,
			gloss: 0.22,
			specular: 0.25,
			streak: 0.9
		} );

		this.mesh = new THREE.Mesh( new THREE.BoxGeometry( hx * 2, hy * 2, hz * 2 ), this.material );
		this.mesh.position.copy( this.center );
		scene.add( this.mesh );

	}

	cellCenter( c, r, out ) {

		const ou = ( c - ( this.cols - 1 ) / 2 ) * this.cellU * 2;
		const ov = ( r - ( this.rows - 1 ) / 2 ) * this.cellV * 2;
		out.copy( this.center )
			.addScaledVector( this.axisU, ou )
			.addScaledVector( this.axisV, ov );
		return out;

	}

	contains( p, pad = 0 ) {

		return Math.abs( p.x - this.center.x ) <= this.half.x + pad &&
			Math.abs( p.y - this.center.y ) <= this.half.y + pad &&
			Math.abs( p.z - this.center.z ) <= this.half.z + pad;

	}

	// Slab test along a ray, for the probe.
	raycast( origin, dir, maxDist, pad = 0 ) {

		let tmin = 0, tmax = maxDist;

		for ( let a = 0; a < 3; a ++ ) {

			const o = a === 0 ? origin.x : a === 1 ? origin.y : origin.z;
			const d = a === 0 ? dir.x : a === 1 ? dir.y : dir.z;
			const c = a === 0 ? this.center.x : a === 1 ? this.center.y : this.center.z;
			const h = ( a === 0 ? this.half.x : a === 1 ? this.half.y : this.half.z ) + pad;

			if ( Math.abs( d ) < 1e-6 ) {

				if ( Math.abs( o - c ) > h ) return - 1;

			} else {

				let t1 = ( c - h - o ) / d;
				let t2 = ( c + h - o ) / d;
				if ( t1 > t2 ) { const s = t1; t1 = t2; t2 = s; }
				tmin = Math.max( tmin, t1 );
				tmax = Math.min( tmax, t2 );
				if ( tmin > tmax ) return - 1;

			}

		}

		return tmin;

	}

	// Did this body cross the slab at any point during the step?
	//
	// The point test this replaces was fine while nothing moved faster than about
	// 8 m/s. Firing at 40 changed that: a shot covers 0.67m per frame against a
	// slab under 0.3m thick including the body radius, so it passed straight
	// through an intact panel and did nothing at all. A fast shot that does no
	// damage is the exact opposite of the thing speed was raised to buy.
	crossed( px, py, pz, vx, vy, vz, dt, pad ) {

		const mx = vx * dt, my = vy * dt, mz = vz * dt;
		const len = Math.sqrt( mx * mx + my * my + mz * mz );

		if ( len < 1e-6 ) {

			_p.set( px, py, pz );
			return this.contains( _p, pad );

		}

		// Cast backwards from where the body ended up, over the distance it
		// covered, plus a little so a body that stopped inside still counts.
		_p.set( px, py, pz );
		_d.set( - mx / len, - my / len, - mz / len );
		const t = this.raycast( _p, _d, len + pad, pad );
		return t >= 0;

	}

}

export class Destruction {

	constructor( scene, rig, solver, debris ) {

		this.scene = scene;
		this.rig = rig;
		this.solver = solver;
		this.debris = debris;
		this.panels = [];
		this.onActivate = null;
		this.onStateChange = null;

		// Panel-scoped scratch for connectivity, grown to the largest panel.
		this._parent = new Int32Array( 0 );

	}

	addPanel( spec ) {

		const p = new WeakPanel( this.scene, spec.rig || this.rig, spec, this.panels.length );
		this.panels.push( p );
		if ( p.chunks.length + 1 > this._parent.length ) this._parent = new Int32Array( p.chunks.length + 1 );
		return p;

	}

	probe( origin, dir, maxDist ) {

		let best = null, bestT = maxDist;

		for ( const p of this.panels ) {

			if ( p.state === PANEL_STATE.OPEN && p.activated ) continue;
			const t = p.raycast( origin, dir, maxDist );
			if ( t >= 0 && t < bestT ) { bestT = t; best = p; }

		}

		return best;

	}

	panelOfGroup( group ) {

		return group >= 0 && group < this.panels.length ? this.panels[ group ] : null;

	}

	// --- activation ---------------------------------------------------------
	//
	// Until something hits it hard enough, a panel is one static mesh and costs
	// nothing. The first qualifying impact converts it into a live lattice and
	// hands the impact straight through to the chunks — which is why nothing
	// below this line needs a damage number ever again. After activation the
	// joints do all of it.

	activate( panel, impactPoint = null, impulse = null ) {

		if ( panel.activated ) return;
		panel.activated = true;
		panel.mesh.visible = false;

		const s = this.solver;
		const spec = panel.spec;
		const n = panel.normal;

		const hu = panel.cellU, hv = panel.cellV, hn = panel.halfN;
		// Half-extents in world axes, derived from the panel frame.
		const ex = Math.abs( n.x ) > 0.5 ? hn : hu;
		const ey = hv;
		const ez = Math.abs( n.x ) > 0.5 ? hu : hn;

		const density = spec.density ?? 0.6;
		const breakForce = spec.breakForce ?? 9000;
		const breakTorque = spec.breakTorque ?? 2600;
		const yieldFrac = spec.yield ?? 0.55;
		const variance = spec.variance ?? 0.35;
		// Coursed masonry fails along its bed joints before it fails across them,
		// so the horizontal runs are stronger than the vertical ones. A single
		// scalar threshold gives isotropic crumble; this at least gets spalling
		// that tends to run in courses.
		const bedBias = spec.bedBias ?? 0.7;
		const frameBias = spec.frameBias ?? 1.8;

		// Deterministic per-panel jitter, so the same panel always fails the same
		// way and §31.3's enumeration stays reproducible.
		let seed = 1013904223 + panel.id * 1664525;
		const rand = () => { seed = ( seed * 1664525 + 1013904223 ) >>> 0; return seed / 4294967296; };
		const jitter = () => 1 + ( rand() - 0.5 ) * 2 * variance;

		for ( let r = 0; r < panel.rows; r ++ ) {

			for ( let c = 0; c < panel.cols; c ++ ) {

				panel.cellCenter( c, r, _p );
				const i = s.spawn( _p.x, _p.y, _p.z, ex, ey, ez, density, MATERIAL_KIND.CONCRETE );
				const idx = r * panel.cols + c;

				if ( i < 0 ) { panel.chunks[ idx ] = - 1; continue; }

				panel.chunks[ idx ] = i;
				panel.rest[ idx * 3 ] = _p.x;
				panel.rest[ idx * 3 + 1 ] = _p.y;
				panel.rest[ idx * 3 + 2 ] = _p.z;
				this.debris.register( i, MATERIAL_KIND.CONCRETE );

			}

		}

		const weld = ( ia, ib, wx, wy, wz, bias ) => {

			const j = s.addJoint( ia, ib, wx, wy, wz,
				breakForce * bias * jitter(), breakTorque * bias * jitter(), yieldFrac, panel.id );
			if ( j >= 0 ) panel.joints.push( j );

		};

		const a = new THREE.Vector3(), b = new THREE.Vector3();

		for ( let r = 0; r < panel.rows; r ++ ) {

			for ( let c = 0; c < panel.cols; c ++ ) {

				const idx = r * panel.cols + c;
				const me = panel.chunks[ idx ];
				if ( me < 0 ) continue;

				panel.cellCenter( c, r, a );

				// Weld across (bed joints, weaker) and up (head joints, stronger).
				if ( c + 1 < panel.cols ) {

					const nb = panel.chunks[ idx + 1 ];
					if ( nb >= 0 ) {

						panel.cellCenter( c + 1, r, b );
						weld( me, nb, ( a.x + b.x ) / 2, ( a.y + b.y ) / 2, ( a.z + b.z ) / 2, 1.0 );

					}

				}

				if ( r + 1 < panel.rows ) {

					const nb = panel.chunks[ idx + panel.cols ];
					if ( nb >= 0 ) {

						panel.cellCenter( c, r + 1, b );
						weld( me, nb, ( a.x + b.x ) / 2, ( a.y + b.y ) / 2, ( a.z + b.z ) / 2, bedBias );

					}

				}

				// Perimeter chunks are tied to the frame. Stronger than the field,
				// so a panel prefers to hole in the middle rather than fall out
				// whole — which is both the more interesting result and the one
				// that produces an aperture instead of a doorway.
				const edge = ( c === 0 ) + ( c === panel.cols - 1 ) + ( r === 0 ) + ( r === panel.rows - 1 );

				if ( edge > 0 ) {

					const ou = c === 0 ? - panel.cellU : ( c === panel.cols - 1 ? panel.cellU : 0 );
					const ov = r === 0 ? - panel.cellV : ( r === panel.rows - 1 ? panel.cellV : 0 );
					b.copy( a ).addScaledVector( panel.axisU, ou ).addScaledVector( panel.axisV, ov );
					weld( me, - 1, b.x, b.y, b.z, frameBias * edge );

				}

			}

		}

		if ( impactPoint && impulse ) {

			this._applyImpulse( panel, impactPoint, impulse );

		}

		this._recompute( panel );
		if ( this.onActivate ) this.onActivate( panel );

	}

	_applyImpulse( panel, point, impulse ) {

		const s = this.solver;
		const radius = Math.max( panel.cellU, panel.cellV ) * 3;

		for ( let k = 0; k < panel.chunks.length; k ++ ) {

			const i = panel.chunks[ k ];
			if ( i < 0 || s.state[ i ] === 0 ) continue;

			const dx = s.px[ i ] - point.x, dy = s.py[ i ] - point.y, dz = s.pz[ i ] - point.z;
			const d = Math.sqrt( dx * dx + dy * dy + dz * dz );
			if ( d > radius ) continue;

			const falloff = 1 - d / radius;
			s.applyImpulse( i, impulse.x * falloff, impulse.y * falloff, impulse.z * falloff );

		}

	}

	// --- pre-activation damage ---------------------------------------------

	update( dt, flight ) {

		const s = this.solver;

		for ( const p of this.panels ) {

			if ( p.activated ) { this._recompute( p ); continue; }

			for ( let i = 0; i < s.count; i ++ ) {

				if ( s.state[ i ] !== 1 ) continue;

				const n = p.normal;
				const into = s.vx[ i ] * n.x + s.vy[ i ] * n.y + s.vz[ i ] * n.z;
				if ( into > - 2.2 ) continue;

				if ( ! p.crossed( s.px[ i ], s.py[ i ], s.pz[ i ],
					s.vx[ i ], s.vy[ i ], s.vz[ i ], dt, s.radius[ i ] ) ) continue;

				_p.set( s.px[ i ], s.py[ i ], s.pz[ i ] );

				const energy = 0.5 * s.mass[ i ] * into * into;
				p.damage += energy * DAMAGE_PER_JOULE;

				if ( p.damage >= ACTIVATION_THRESHOLD ) {

					// Hand the strike straight through: the panel comes alive
					// already being hit, so the first hole is where you aimed.
					const imp = { x: - n.x * into * s.mass[ i ], y: - n.y * into * s.mass[ i ], z: - n.z * into * s.mass[ i ] };
					this.activate( p, _p.clone(), imp );
					break;

				}

				s.vx[ i ] -= n.x * into * 1.2;
				s.vy[ i ] -= n.y * into * 1.2;
				s.vz[ i ] -= n.z * into * 1.2;

			}

			if ( ! p.activated && p.contains( flight.position, 0.4 ) && flight.lastImpact > 3 ) {

				p.damage += flight.lastImpact * 1.5;
				if ( p.damage >= ACTIVATION_THRESHOLD ) this.activate( p );

			}

		}

	}

	// --- connectivity and aperture ------------------------------------------
	//
	// Called when a joint in this panel fractures. Everything here is a graph
	// query; nothing simulates structural integrity.

	onFracture( group ) {

		const panel = this.panelOfGroup( group );
		if ( panel ) this._recompute( panel, true );

	}

	// `wake` only on a fracture. Chunks fall out for seconds after the last weld
	// goes, so the aperture has to be re-read every frame — but re-waking the
	// orphans every frame would stop the debris ever settling.
	_recompute( panel, wake = false ) {

		const s = this.solver;
		const n = panel.chunks.length;

		// Anything that just lost its path to the frame has to be woken, or it
		// hangs in mid-air: gravity is only integrated for awake bodies, and
		// breaking a weld only wakes its own two ends. A chunk three hops away
		// can be orphaned without ever being touched.
		if ( wake ) this._wakeDetached( panel );

		// A cell is open when its chunk is gone, or has travelled far enough from
		// where it was authored to stop plugging the hole. Purely geometric — it
		// does not care whether the chunk is still jointed to something.
		const limit = Math.min( panel.cellU, panel.cellV ) * 2 * OPEN_FRACTION;
		let openCount = 0;

		for ( let k = 0; k < n; k ++ ) {

			const i = panel.chunks[ k ];
			let isOpen = 1;

			if ( i >= 0 && s.state[ i ] !== 0 ) {

				const dx = s.px[ i ] - panel.rest[ k * 3 ];
				const dy = s.py[ i ] - panel.rest[ k * 3 + 1 ];
				const dz = s.pz[ i ] - panel.rest[ k * 3 + 2 ];
				if ( dx * dx + dy * dy + dz * dz < limit * limit ) isOpen = 0;

			}

			panel.open[ k ] = isOpen;
			openCount += isOpen;

		}

		const prev = panel.state;
		panel.openCount = openCount;
		panel.state = openCount === 0
			? PANEL_STATE.INTACT
			: ( this._hasAperture( panel ) ? PANEL_STATE.OPEN : PANEL_STATE.BREACHED );

		if ( panel.state !== prev && this.onStateChange ) this.onStateChange( panel, prev );

	}

	// Is there a rectangle of open cells the player fits through? Exact rather
	// than sampled, and cheap enough to run inside §31.3's enumeration over every
	// reachable destruction state of every level.
	_hasAperture( panel, radius = 0.34 ) {

		const needU = Math.max( 1, Math.ceil( ( radius + 0.06 ) / panel.cellU ) );
		const needV = Math.max( 1, Math.ceil( ( radius + 0.06 ) / panel.cellV ) );

		if ( needU > panel.cols || needV > panel.rows ) return false;

		for ( let r = 0; r + needV <= panel.rows; r ++ ) {

			for ( let c = 0; c + needU <= panel.cols; c ++ ) {

				let all = true;

				for ( let dr = 0; dr < needV && all; dr ++ ) {

					for ( let dc = 0; dc < needU; dc ++ ) {

						if ( panel.open[ ( r + dr ) * panel.cols + c + dc ] === 0 ) { all = false; break; }

					}

				}

				if ( all ) return true;

			}

		}

		return false;

	}

	_wakeDetached( panel ) {

		const s = this.solver;
		const loose = this._detached( panel );

		for ( let k = 0; k < loose.length; k ++ ) {

			const i = panel.chunks[ loose[ k ] ];
			if ( i >= 0 && s.state[ i ] !== 0 ) s.wake( i );

		}

	}

	detachedCount( panel ) {

		return this._detached( panel ).length;

	}

	// Union-find over surviving joints. §32.3: a piece disconnected from its
	// surroundings falls, anything still attached stays. Slot `n` is the frame.
	// Returns the cells with no remaining path to it — they are already falling,
	// since the joints were the only thing holding them up.
	_detached( panel ) {

		const s = this.solver;
		const n = panel.chunks.length;
		const parent = this._parent;
		const out = this._loose || ( this._loose = [] );
		out.length = 0;

		for ( let k = 0; k <= n; k ++ ) parent[ k ] = k;

		const find = x => { while ( parent[ x ] !== x ) { parent[ x ] = parent[ parent[ x ] ]; x = parent[ x ]; } return x; };
		const union = ( x, y ) => { const a = find( x ), b = find( y ); if ( a !== b ) parent[ a ] = b; };

		const slotOf = new Map();
		for ( let k = 0; k < n; k ++ ) if ( panel.chunks[ k ] >= 0 ) slotOf.set( panel.chunks[ k ], k );

		for ( const j of panel.joints ) {

			if ( s.jState[ j ] !== 1 ) continue;
			const a = slotOf.get( s.jA[ j ] );
			if ( a === undefined ) continue;
			const bBody = s.jB[ j ];
			const b = bBody < 0 ? n : slotOf.get( bBody );
			if ( b === undefined ) continue;
			union( a, b );

		}

		const frame = find( n );

		for ( let k = 0; k < n; k ++ ) {

			if ( panel.chunks[ k ] < 0 ) continue;
			if ( find( k ) !== frame ) out.push( k );

		}

		return out;

	}

	liveJoints( panel ) {

		let n = 0;
		for ( const j of panel.joints ) if ( this.solver.jState[ j ] === 1 ) n ++;
		return n;

	}

	restore( panel ) {

		const s = this.solver;

		for ( const j of panel.joints ) if ( s.jState[ j ] === 1 ) s.breakJoint( j );
		for ( let k = 0; k < panel.chunks.length; k ++ ) {

			const i = panel.chunks[ k ];
			if ( i >= 0 && s.state[ i ] !== 0 ) s.release( i );
			panel.chunks[ k ] = - 1;

		}

		panel.joints.length = 0;
		panel.open.fill( 0 );
		panel.openCount = 0;
		panel.damage = 0;
		panel.activated = false;
		panel.state = PANEL_STATE.INTACT;
		panel.mesh.visible = true;

	}

}

// Three weak panels, well under the §33.3 cap of twelve. Placed so one is
// obvious, one needs looking for, and one is behind you when you arrive. Their
// bond parameters differ so the three failure characters are visibly distinct.
export function addTestPanels( destruction, rig, room ) {

	const R = room;

	const specs = [
		{
			// The one that matters: it fills the opening in the interior
			// partition, so an aperture here is a route rather than a readout.
			// Coursed block — holes cleanly, courses spall, frame holds.
			cx: ( R.partition.x0 + R.partition.x1 ) / 2,
			cy: ( R.partition.y0 + R.partition.y1 ) / 2,
			cz: R.partition.z,
			hx: ( R.partition.x1 - R.partition.x0 ) / 2,
			hy: ( R.partition.y1 - R.partition.y0 ) / 2,
			hz: R.partition.t,
			normal: new THREE.Vector3( 0, 0, 1 ), cols: 6, rows: 7, rig,
			breakForce: 9000, breakTorque: 2600, bedBias: 0.65, frameBias: 2.0, variance: 0.35
		},
		{
			// Tired and water-damaged: low thresholds, high variance, weak frame.
			// Loses whole slabs instead of neat holes.
			cx: R.halfW - 0.16, cy: 3.6, cz: 4.5, hx: 0.14, hy: 1.0, hz: 1.8,
			normal: new THREE.Vector3( - 1, 0, 0 ), cols: 6, rows: 5, rig,
			breakForce: 5600, breakTorque: 1700, bedBias: 0.85, frameBias: 1.1, variance: 0.6, yield: 0.4
		},
		{
			// Well tied and stiff. Takes real punishment, then goes at once.
			cx: 2.0, cy: 4.8, cz: R.halfD - 0.16, hx: 1.2, hy: 1.5, hz: 0.14,
			normal: new THREE.Vector3( 0, 0, - 1 ), cols: 5, rows: 7, rig,
			breakForce: 15000, breakTorque: 4800, bedBias: 0.9, frameBias: 2.6, variance: 0.2, yield: 0.75
		}
	];

	return specs.map( s => destruction.addPanel( s ) );

}
