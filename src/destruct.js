// Authored destruction.
//
// §7.4: each breakable is hand-made with discrete states — intact, stressed,
// blown — plus a fixed chunk set. No runtime Voronoi, no continuous geometry.
// The reason is not only cost: a weak wall with three states is a *node*, which
// is what makes §31.3's exhaustive enumeration of the destruction state space
// possible at all. Rarity is what makes this affordable (§23.2), and §33.3 caps
// it at roughly twelve per floor so 2^n stays enumerable.
//
// §7.2: breaking a wall must be hard. Panels are telegraphed visually and
// confirmed by probe, and nothing else in the room can be broken at all.

import * as THREE from 'three';
import { createSurfaceMaterial } from './materials.js';
import { MATERIAL_KIND } from './room.js';

export const PANEL_STATE = { INTACT: 0, STRESSED: 1, BLOWN: 2 };

// Damage is 3% of impact kinetic energy in joules. §7.2 — breaking a wall must
// be hard: three thrown pavers stress a panel, ten blow it, and one 85kg drum at
// speed does the job on its own. The heavy object is the keycard (§7.3).
const DAMAGE_PER_JOULE = 0.03;
const STRESS_THRESHOLD = 110;
const BLOW_THRESHOLD = 380;

const _dir = new THREE.Vector3();

class WeakPanel {

	constructor( scene, rig, spec ) {

		this.spec = spec;
		this.state = PANEL_STATE.INTACT;
		this.damage = 0;
		this.chunksSpawned = false;

		const { cx, cy, cz, hx, hy, hz } = spec;
		this.center = new THREE.Vector3( cx, cy, cz );
		this.half = new THREE.Vector3( hx, hy, hz );

		// Fatigued, water-damaged, poorly tied — it should read wrong before you
		// probe it, not only after.
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

	contains( p, pad = 0 ) {

		return Math.abs( p.x - this.center.x ) <= this.half.x + pad &&
			Math.abs( p.y - this.center.y ) <= this.half.y + pad &&
			Math.abs( p.z - this.center.z ) <= this.half.z + pad;

	}

	// Slab test along a ray, for the probe.
	raycast( origin, dir, maxDist ) {

		let tmin = 0, tmax = maxDist;

		for ( let a = 0; a < 3; a ++ ) {

			const o = a === 0 ? origin.x : a === 1 ? origin.y : origin.z;
			const d = a === 0 ? dir.x : a === 1 ? dir.y : dir.z;
			const c = a === 0 ? this.center.x : a === 1 ? this.center.y : this.center.z;
			const h = a === 0 ? this.half.x : a === 1 ? this.half.y : this.half.z;

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

	applyDamage( amount ) {

		if ( this.state === PANEL_STATE.BLOWN ) return false;

		this.damage += amount;

		if ( this.state === PANEL_STATE.INTACT && this.damage >= STRESS_THRESHOLD ) {

			this.state = PANEL_STATE.STRESSED;
			// Stressed reads as a panel that has moved: proud of the wall, dark
			// at the joint, obviously about to go.
			this.mesh.position.copy( this.center ).addScaledVector( this.spec.normal, 0.045 );
			this.mesh.rotation.z = 0.012;
			this.material.uniforms.uGrout.value.setHex( 0x2a1405 );
			return true;

		}

		if ( this.state === PANEL_STATE.STRESSED && this.damage >= BLOW_THRESHOLD ) {

			this.state = PANEL_STATE.BLOWN;
			return true;

		}

		return false;

	}

}

export class Destruction {

	constructor( scene, rig, solver, debris ) {

		this.scene = scene;
		this.solver = solver;
		this.debris = debris;
		this.panels = [];
		this.onStateChange = null;

	}

	addPanel( spec ) {

		const p = new WeakPanel( this.scene, this._rig || ( this._rig = spec.rig ), spec );
		this.panels.push( p );
		return p;

	}

	probe( origin, dir, maxDist ) {

		let best = null, bestT = maxDist;

		for ( const p of this.panels ) {

			if ( p.state === PANEL_STATE.BLOWN ) continue;
			const t = p.raycast( origin, dir, maxDist );
			if ( t >= 0 && t < bestT ) { bestT = t; best = p; }

		}

		return best;

	}

	// Anything moving fast enough inside a panel's volume damages it. The
	// instruments of destruction are the keycards (§7.3) — you cannot break this
	// with intent alone, only with something heavy you found and aimed.
	update( dt, flight ) {

		const s = this.solver;

		for ( const p of this.panels ) {

			if ( p.state === PANEL_STATE.BLOWN ) continue;

			for ( let i = 0; i < s.count; i ++ ) {

				if ( s.state[ i ] !== 1 ) continue;

				_dir.set( s.px[ i ], s.py[ i ], s.pz[ i ] );
				if ( ! p.contains( _dir, s.radius[ i ] ) ) continue;

				// Only the component travelling *into* the panel does work, and
				// only on the way in. Without the direction gate a single hit
				// bills for every frame the chunk spends inside the volume,
				// including the frames it is bouncing back out.
				const n = p.spec.normal;
				const into = s.vx[ i ] * n.x + s.vy[ i ] * n.y + s.vz[ i ] * n.z;
				if ( into > - 2.2 ) continue;

				const energy = 0.5 * s.mass[ i ] * into * into;

				if ( p.applyDamage( energy * DAMAGE_PER_JOULE ) ) this._onChange( p );

				// Reflect with a low restitution — masonry, not a trampoline.
				s.vx[ i ] -= n.x * into * 1.2;
				s.vy[ i ] -= n.y * into * 1.2;
				s.vz[ i ] -= n.z * into * 1.2;

			}

			// The player can ram it too, badly and slowly, which is the correct
			// relative cost: your own mass is 4kg and a drum is 90.
			if ( p.contains( flight.position, 0.4 ) && flight.lastImpact > 3 ) {

				if ( p.applyDamage( flight.lastImpact * 1.5 ) ) this._onChange( p );

			}

		}

	}

	_onChange( p ) {

		if ( p.state === PANEL_STATE.BLOWN && ! p.chunksSpawned ) this._blow( p );
		if ( this.onStateChange ) this.onStateChange( p );

	}

	// The fixed chunk set. Deterministic grid, authored counts, no fracture at
	// runtime. Chunks inherit the panel's material so the debris is visibly the
	// wall it came out of.
	_blow( p ) {

		p.chunksSpawned = true;
		p.mesh.visible = false;

		const s = this.solver;
		const spec = p.spec;
		const nx = spec.cols ?? 4, ny = spec.rows ?? 5;
		const n = spec.normal;

		const cw = p.half.x / nx, ch = p.half.y / ny, cd = p.half.z;

		for ( let gy = 0; gy < ny; gy ++ ) {

			for ( let gx = 0; gx < nx; gx ++ ) {

				const ox = ( gx - ( nx - 1 ) / 2 ) * cw * 2;
				const oy = ( gy - ( ny - 1 ) / 2 ) * ch * 2;

				const i = s.spawn(
					p.center.x + ( Math.abs( n.x ) > 0.5 ? 0 : ox ),
					p.center.y + oy,
					p.center.z + ( Math.abs( n.x ) > 0.5 ? ox : 0 ),
					Math.abs( n.x ) > 0.5 ? cd : cw,
					ch,
					Math.abs( n.x ) > 0.5 ? cw : cd,
					0.6,
					MATERIAL_KIND.CONCRETE
				);

				if ( i < 0 ) continue;

				this.debris.register( i, MATERIAL_KIND.CONCRETE );

				// Blow inward, harder at the centre. Chunks should arrive as a
				// cone, not a curtain.
				const falloff = 1 - Math.min( 1, Math.hypot( ox, oy ) / Math.hypot( p.half.x, p.half.y ) );
				const push = 1.4 + falloff * 3.6;

				s.vx[ i ] = n.x * push + ( Math.random() - 0.5 ) * 0.9;
				s.vy[ i ] = n.y * push + ( Math.random() - 0.5 ) * 0.9 + 0.6;
				s.vz[ i ] = n.z * push + ( Math.random() - 0.5 ) * 0.9;

				s.wx[ i ] = ( Math.random() - 0.5 ) * 7;
				s.wy[ i ] = ( Math.random() - 0.5 ) * 7;
				s.wz[ i ] = ( Math.random() - 0.5 ) * 7;

			}

		}

	}

}

// Three weak panels, well under the §33.3 cap of twelve. Placed so one is
// obvious, one needs looking for, and one is behind you when you arrive.
export function addTestPanels( destruction, rig, room ) {

	const R = room;

	const specs = [
		{
			cx: - 4.5, cy: 4.2, cz: - R.halfD + 0.16, hx: 1.5, hy: 1.25, hz: 0.14,
			normal: new THREE.Vector3( 0, 0, 1 ), cols: 4, rows: 5, rig
		},
		{
			cx: R.halfW - 0.16, cy: 3.6, cz: 4.5, hx: 0.14, hy: 1.0, hz: 1.8,
			normal: new THREE.Vector3( - 1, 0, 0 ), cols: 5, rows: 4, rig
		},
		{
			cx: 2.0, cy: 4.8, cz: R.halfD - 0.16, hx: 1.2, hy: 1.5, hz: 0.14,
			normal: new THREE.Vector3( 0, 0, - 1 ), cols: 3, rows: 5, rig
		}
	];

	return specs.map( s => destruction.addPanel( s ) );

}
