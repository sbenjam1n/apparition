// Debris rendering: one InstancedMesh over the whole solver.
//
// The solver keeps its state in structure-of-arrays typed buffers; this walks
// them once per frame and writes instance matrices. No per-chunk Object3D, no
// per-chunk material, no scene graph churn — a few hundred chunks cost one draw
// call and one buffer upload, which is the difference between this running on a
// 2019 MacBook and not.
//
// Two index spaces, kept strictly separate: solver *body* indices are stable and
// sparse (bodies are freed and recycled), GPU *slot* indices are dense and
// recomputed every frame. Per-body channels live in their own arrays and are
// gathered into slot order at upload time.

import * as THREE from 'three';
import { createDebrisMaterial } from './materials.js';
import { materialTint } from './room.js';

export class DebrisField {

	constructor( scene, rig, solver ) {

		this.solver = solver;
		const N = solver.maxBodies;

		const geo = new THREE.BoxGeometry( 1, 1, 1 );
		this.material = createDebrisMaterial( rig );

		// Per body.
		this.bodyHeat = new Float32Array( N );
		this.bodyTint = new Float32Array( N * 3 );

		// Per slot — what the GPU actually reads.
		this.slotHeat = new Float32Array( N );
		this.slotTint = new Float32Array( N * 3 );

		this.heatAttr = new THREE.InstancedBufferAttribute( this.slotHeat, 1 );
		this.tintAttr = new THREE.InstancedBufferAttribute( this.slotTint, 3 );
		this.heatAttr.setUsage( THREE.DynamicDrawUsage );
		this.tintAttr.setUsage( THREE.DynamicDrawUsage );
		geo.setAttribute( 'aHeat', this.heatAttr );
		geo.setAttribute( 'aTint', this.tintAttr );

		this.mesh = new THREE.InstancedMesh( geo, this.material, N );
		this.mesh.instanceMatrix.setUsage( THREE.DynamicDrawUsage );
		this.mesh.frustumCulled = false;
		this.mesh.count = 0;
		scene.add( this.mesh );

		this._m = new THREE.Matrix4();
		this._p = new THREE.Vector3();
		this._q = new THREE.Quaternion();
		this._s = new THREE.Vector3();

	}

	register( bodyIndex, kind ) {

		const c = materialTint( kind );
		this.bodyTint[ bodyIndex * 3 ] = c.r;
		this.bodyTint[ bodyIndex * 3 + 1 ] = c.g;
		this.bodyTint[ bodyIndex * 3 + 2 ] = c.b;
		this.bodyHeat[ bodyIndex ] = 0;

	}

	// The funnel re-raises this every frame it is pulling, so leaving the draw
	// shows immediately while cooling takes its time — heat has lag (§5.3).
	setHeat( bodyIndex, value ) {

		if ( value > this.bodyHeat[ bodyIndex ] ) this.bodyHeat[ bodyIndex ] = value;

	}

	update( dt ) {

		const s = this.solver;
		const m = this._m, p = this._p, q = this._q, sc = this._s;
		let slot = 0;

		for ( let i = 0; i < s.count; i ++ ) {

			if ( s.state[ i ] === 0 ) continue;

			if ( this.bodyHeat[ i ] > 0 ) {

				this.bodyHeat[ i ] = Math.max( 0, this.bodyHeat[ i ] - dt * 1.6 );

			}

			p.set( s.px[ i ], s.py[ i ], s.pz[ i ] );
			q.set( s.qx[ i ], s.qy[ i ], s.qz[ i ], s.qw[ i ] );
			sc.set( s.hx[ i ] * 2, s.hy[ i ] * 2, s.hz[ i ] * 2 );
			m.compose( p, q, sc );
			this.mesh.setMatrixAt( slot, m );

			this.slotHeat[ slot ] = this.bodyHeat[ i ];
			this.slotTint[ slot * 3 ] = this.bodyTint[ i * 3 ];
			this.slotTint[ slot * 3 + 1 ] = this.bodyTint[ i * 3 + 1 ];
			this.slotTint[ slot * 3 + 2 ] = this.bodyTint[ i * 3 + 2 ];

			slot ++;

		}

		this.mesh.count = slot;
		this.mesh.instanceMatrix.needsUpdate = true;
		this.heatAttr.needsUpdate = true;
		this.tintAttr.needsUpdate = true;

	}

}
