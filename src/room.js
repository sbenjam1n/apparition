// The test room.
//
// One volume that carries both references: a tiled wet-plant hall with a sunken
// pool (mint cove strip on the wainscot, caustics as the brightest thing in
// frame), and — down the far end, lost in haze — a colonnade of black slab piers
// each raked by a single hot vertical strip.
//
// Both are the same room because they are the same lighting primitive at
// different colour temperatures, and because a greybox that only demonstrates one
// look tells you nothing about whether the rig generalises.
//
// Everything here is authored, not generated. §7.4: discrete states, fixed chunk
// sets, no runtime fracture. §33.3 caps weak walls at twelve per floor so the
// destruction state space stays exhaustively checkable; this room uses three.

import * as THREE from 'three';
import { createSurfaceMaterial, createWaterMaterial, createEmitterMaterial } from './materials.js';

export const ROOM = {
	halfW: 13,
	halfD: 14,
	height: 9,
	wainscot: 2.6,
	pool: { x0: - 3.4, x1: 3.4, z0: 1.0, z1: 7.4, bottom: - 1.4, water: - 0.28 },
	piers: [ { z: - 2.5 }, { z: - 7.0 }, { z: - 11.5 } ],
	pierX: 7.6,
	pierHalf: { x: 0.7, y: 2.6, z: 1.9 }
};

export const MATERIAL_KIND = { TILE: 0, CONCRETE: 1, GLASS: 2, STEEL: 3 };

const TINTS = [
	new THREE.Color( 0x9fb2ae ),   // tile
	new THREE.Color( 0x5c6266 ),   // concrete
	new THREE.Color( 0x7fd8e8 ),   // glass
	new THREE.Color( 0x8a9099 )    // steel
];

export function materialTint( kind ) {

	return TINTS[ kind ] || TINTS[ 0 ];

}

export function buildRoom( scene, rig, solver ) {

	const g = new THREE.Group();
	scene.add( g );

	const R = ROOM;
	const P = R.pool;

	rig.uniforms.uWaterLevel.value = P.water;
	rig.uniforms.uFogFloor.value = P.bottom;
	rig.uniforms.uPoolBounds.value.set( P.x0, P.z0, P.x1, P.z1 );

	// --- surfaces -----------------------------------------------------------

	const tiled = createSurfaceMaterial( rig, {
		tileScale: 3.4,
		groutWidth: 1.15,
		upper: 0xc2cfca,
		lower: 0x0d1418,
		grout: 0x04070a,
		wainscot: R.wainscot,
		wainscotBlend: 0.05,
		gloss: 0.5,
		specular: 0.55,
		streak: 0.35
	} );

	// The piers are the other reference: near-black, vertically jointed, no tile
	// grid, glossy enough to hold a highlight down their whole length.
	const slab = createSurfaceMaterial( rig, {
		tileScale: 0.55,
		groutWidth: 0.8,
		upper: 0x0a0e12,
		lower: 0x070a0d,
		grout: 0x030507,
		wainscot: - 99,
		gloss: 0.82,
		specular: 0.9,
		streak: 0.55
	} );

	const plane = ( w, h, pos, rot, mat ) => {

		const m = new THREE.Mesh( new THREE.PlaneGeometry( w, h ), mat );
		m.position.set( pos[ 0 ], pos[ 1 ], pos[ 2 ] );
		m.rotation.set( rot[ 0 ], rot[ 1 ], rot[ 2 ] );
		g.add( m );
		return m;

	};

	const box = ( hx, hy, hz, cx, cy, cz, mat ) => {

		const m = new THREE.Mesh( new THREE.BoxGeometry( hx * 2, hy * 2, hz * 2 ), mat );
		m.position.set( cx, cy, cz );
		g.add( m );
		return m;

	};

	const HP = Math.PI / 2;

	// Walls and ceiling, facing inward.
	plane( R.halfW * 2, R.height, [ 0, R.height / 2, - R.halfD ], [ 0, 0, 0 ], tiled );
	plane( R.halfW * 2, R.height, [ 0, R.height / 2, R.halfD ], [ 0, Math.PI, 0 ], tiled );
	plane( R.halfD * 2, R.height, [ - R.halfW, R.height / 2, 0 ], [ 0, HP, 0 ], tiled );
	plane( R.halfD * 2, R.height, [ R.halfW, R.height / 2, 0 ], [ 0, - HP, 0 ], tiled );
	plane( R.halfW * 2, R.halfD * 2, [ 0, R.height, 0 ], [ HP, 0, 0 ], tiled );

	// Floor built as four slabs around the pool void, so debris genuinely falls in.
	const slabs = [
		[ R.halfW, 0.5, ( P.z0 + R.halfD ) / 2, 0, - 0.5, ( P.z0 - R.halfD ) / 2 ],
		[ R.halfW, 0.5, ( R.halfD - P.z1 ) / 2, 0, - 0.5, ( P.z1 + R.halfD ) / 2 ],
		[ ( P.x0 + R.halfW ) / 2, 0.5, ( P.z1 - P.z0 ) / 2, ( P.x0 - R.halfW ) / 2, - 0.5, ( P.z0 + P.z1 ) / 2 ],
		[ ( R.halfW - P.x1 ) / 2, 0.5, ( P.z1 - P.z0 ) / 2, ( P.x1 + R.halfW ) / 2, - 0.5, ( P.z0 + P.z1 ) / 2 ]
	];

	for ( const s of slabs ) {

		box( s[ 0 ], s[ 1 ], s[ 2 ], s[ 3 ], s[ 4 ], s[ 5 ], tiled );
		solver.addBox( s[ 3 ], s[ 4 ], s[ 5 ], s[ 0 ], s[ 1 ], s[ 2 ], 0.62, MATERIAL_KIND.TILE );

	}

	// Pool: dark tiled tank plus an emissive caustic sheet.
	const tankH = ( 0 - P.bottom ) / 2;
	const tankY = P.bottom + tankH;
	const pw = ( P.x1 - P.x0 ) / 2, pd = ( P.z1 - P.z0 ) / 2;
	const pcx = ( P.x0 + P.x1 ) / 2, pcz = ( P.z0 + P.z1 ) / 2;

	plane( pw * 2, pd * 2, [ pcx, P.bottom, pcz ], [ - HP, 0, 0 ], tiled );
	plane( pw * 2, tankH * 2, [ pcx, tankY, P.z0 ], [ 0, 0, 0 ], tiled );
	plane( pw * 2, tankH * 2, [ pcx, tankY, P.z1 ], [ 0, Math.PI, 0 ], tiled );
	plane( pd * 2, tankH * 2, [ P.x0, tankY, pcz ], [ 0, HP, 0 ], tiled );
	plane( pd * 2, tankH * 2, [ P.x1, tankY, pcz ], [ 0, - HP, 0 ], tiled );

	solver.addBox( pcx, P.bottom - 0.5, pcz, pw, 0.5, pd, 0.62, MATERIAL_KIND.TILE );

	const water = new THREE.Mesh( new THREE.PlaneGeometry( pw * 2, pd * 2 ), createWaterMaterial( rig ) );
	water.rotation.x = - HP;
	water.position.set( pcx, P.water, pcz );
	g.add( water );

	// Room bounds as half-spaces for the solver. Cheaper than boxes and they can
	// never be escaped, which matters more than accuracy for a containment volume.
	solver.addPlane( 1, 0, 0, - R.halfW + 0.05, 0.55, MATERIAL_KIND.TILE );
	solver.addPlane( - 1, 0, 0, - R.halfW + 0.05, 0.55, MATERIAL_KIND.TILE );
	solver.addPlane( 0, 0, 1, - R.halfD + 0.05, 0.55, MATERIAL_KIND.TILE );
	solver.addPlane( 0, 0, - 1, - R.halfD + 0.05, 0.55, MATERIAL_KIND.TILE );
	solver.addPlane( 0, - 1, 0, - R.height + 0.05, 0.55, MATERIAL_KIND.TILE );

	// --- fixtures -----------------------------------------------------------

	const MINT = 0x2fffcb;
	const COLD = 0xdcf2ff;
	const emitters = new THREE.Group();
	g.add( emitters );

	const stripMesh = ( a, b, color, thickness = 0.045 ) => {

		const dir = new THREE.Vector3().subVectors( b, a );
		const len = dir.length();
		const m = new THREE.Mesh(
			new THREE.BoxGeometry( thickness, thickness, len ),
			createEmitterMaterial( color, 2.4 )
		);
		m.position.copy( a ).addScaledVector( dir, 0.5 );
		m.lookAt( b );
		emitters.add( m );
		return m;

	};

	// Wainscot cove — the mint line the pool room is built around. Slightly proud
	// of the wall so it rakes upward instead of washing flat.
	const cove = R.wainscot - 0.1;
	const off = 0.28;
	const coveRuns = [
		[ - R.halfW + 0.1, cove, - R.halfD + off, R.halfW - 0.1, cove, - R.halfD + off ],
		[ - R.halfW + 0.1, cove, R.halfD - off, R.halfW - 0.1, cove, R.halfD - off ],
		[ - R.halfW + off, cove, - R.halfD + 0.1, - R.halfW + off, cove, R.halfD - 0.1 ],
		[ R.halfW - off, cove, - R.halfD + 0.1, R.halfW - off, cove, R.halfD - 0.1 ]
	];

	for ( const r of coveRuns ) {

		const s = rig.addStrip( r[ 0 ], r[ 1 ], r[ 2 ], r[ 3 ], r[ 4 ], r[ 5 ], MINT, 1.3, 9 );
		s.mesh = stripMesh( new THREE.Vector3( r[ 0 ], r[ 1 ], r[ 2 ] ), new THREE.Vector3( r[ 3 ], r[ 4 ], r[ 5 ] ), MINT );

	}

	// Piers, and the hot vertical rake on each. Four strips are already spent on
	// the cove, so the three piers take the remaining budget exactly.
	for ( const p of R.piers ) {

		box( R.pierHalf.x, R.pierHalf.y, R.pierHalf.z, R.pierX, R.pierHalf.y, p.z, slab );
		solver.addBox( R.pierX, R.pierHalf.y, p.z, R.pierHalf.x, R.pierHalf.y, R.pierHalf.z, 0.7, MATERIAL_KIND.CONCRETE );

		const fx = R.pierX - R.pierHalf.x - 0.22;
		const s = rig.addStrip( fx, 0.06, p.z - R.pierHalf.z, fx, 0.06, p.z + R.pierHalf.z, COLD, 1.35, 5.0 );
		s.mesh = stripMesh(
			new THREE.Vector3( fx, 0.06, p.z - R.pierHalf.z ),
			new THREE.Vector3( fx, 0.06, p.z + R.pierHalf.z ),
			COLD, 0.035
		);

	}

	// Practicals: two failing overheads and an exit sign. The exit sign is
	// battery-backed, so draining it costs no grid draw at all (§35.4) — it is
	// deliberately the last light that will be left in here.
	const lamps = [
		rig.addPractical( - 6.5, R.height - 0.8, - 4.0, 0xffd9a8, 0.85, 7 ),
		rig.addPractical( - 2.0, R.height - 0.8, 6.0, 0xffd9a8, 0.6, 6.5 ),
		rig.addPractical( - R.halfW + 0.6, 3.4, - R.halfD + 1.2, 0x39ff88, 0.4, 3.5 )
	];

	for ( const l of lamps ) {

		const m = new THREE.Mesh( new THREE.SphereGeometry( 0.11, 8, 6 ), createEmitterMaterial( l.color, 2 ) );
		m.position.copy( l.pos );
		emitters.add( m );
		l.mesh = m;

	}

	lamps[ 0 ].flicker = 0.08;
	lamps[ 0 ]._decay = 0.4;

	return { group: g, emitters, materials: { tiled, slab }, lamps };

}

// Loose objects that exist only so the empty room is not empty. §8.1: a room's
// armoury is its furniture, and the killing test needs something with mass in it
// from the first second.
// Density is specific gravity — 2.4 is concrete, 2.5 glass, 0.3 a half-empty
// drum. `spawn` scales by 1000, so masses come out in kilograms and the throw /
// recoil economy is in real units rather than in arbitrary ones.
export function scatterProps( solver, spawnDebris ) {

	const P = ROOM.pool;
	const props = [];

	const add = ( x, y, z, hx, hy, hz, density, kind ) => {

		const i = solver.spawn( x, y, z, hx, hy, hz, density, kind );
		if ( i >= 0 ) { spawnDebris( i, kind ); props.push( i ); }
		return i;

	};

	// A bench: ~430kg, the thing you learn recoil on. Moving it should cost you
	// your position as much as your watts.
	add( - 5.0, 0.22, 3.0, 0.9, 0.1, 0.25, 2.4, MATERIAL_KIND.CONCRETE );
	add( - 5.6, 0.55, 3.0, 0.08, 0.22, 0.08, 2.4, MATERIAL_KIND.CONCRETE );
	add( - 4.4, 0.55, 3.0, 0.08, 0.22, 0.08, 2.4, MATERIAL_KIND.CONCRETE );

	// Stacked pavers by the pool lip — ~11kg each, light, plentiful, satisfying
	// to sweep. This is the ammunition the killing test actually runs on.
	for ( let i = 0; i < 15; i ++ ) {

		add(
			P.x1 + 0.9 + ( i % 3 ) * 0.34,
			0.09 + Math.floor( i / 3 ) * 0.07,
			P.z0 + 1.1 + ( i % 5 ) * 0.36,
			0.15, 0.03, 0.15, 2.4, MATERIAL_KIND.TILE
		);

	}

	// Drums in the fogged end. Placed on the open side of the piers, clear of
	// their footprint — a prop spawned inside a static collider gets ejected at
	// speed on the first step, which looks exactly like a physics bug.
	for ( let i = 0; i < 5; i ++ ) {

		add( 3.2 + i * 0.78, 0.46, - 6.2 - ( i % 2 ) * 1.2, 0.28, 0.45, 0.28, 0.3, MATERIAL_KIND.STEEL );

	}

	// A pallet of glass: ~16kg a sheet, the lightest thing here, and the loudest.
	for ( let i = 0; i < 10; i ++ ) {

		add( - 8.0 + ( i % 5 ) * 0.66, 0.05 + Math.floor( i / 5 ) * 0.03, - 6.0 + ( i % 3 ) * 0.5,
			0.3, 0.012, 0.22, 2.5, MATERIAL_KIND.GLASS );

	}

	return props;

}
