// Metasurfaces.
//
// Ross Bencina's Metasurface (NIME 2005, "Applying Natural Neighbour
// Interpolation to Two-to-Many Mapping") is an interface for designing
// two-to-many mappings by *placing parameter snapshots on a plane* and
// interpolating between them as a cursor moves across it. Its whole argument is
// the choice of interpolation: natural neighbour is local and based on a Voronoi
// tessellation, which he contrasts against global field methods on exactly the
// grounds that matter here — predictability, and the ability to hold detail at
// several scales on one surface without a preset on the far side of the room
// quietly influencing this corner of it.
//
// The fit is almost embarrassing. The zones this replaces were spheres with a
// radius and a feather, which means two hand-tuned numbers per region, overlaps
// that sum to more than one, and gaps that sum to less. A metasurface has no
// radius: presets are dropped where they belong, and every point in the plane
// gets a blend whose weights sum to one by construction. Placement *is* the
// authoring.
//
// Sibson's weights are area-stealing. Insert the query point into the Voronoi
// diagram; its new cell takes area from each of its natural neighbours, and each
// neighbour's weight is the fraction it lost. Computing that exactly means real
// computational geometry, so this uses the standard discrete form, which is the
// same definition evaluated by sampling:
//
//   scatter points around the query; for each, find its nearest preset; if it is
//   closer to the query than to that preset, the query would have stolen it, so
//   credit a steal to that preset. Weights are steals over total steals.
//
// That gives every property the geometric version has — partition of unity, local
// support, exactness at the presets, continuity between them — for a few thousand
// distance comparisons a frame, and it degrades gracefully outside the convex
// hull, where Sibson is strictly undefined and a game still has to draw something.
//
// "Layers of metasurfaces": each surface owns a disjoint set of parameters, so
// the surface describing the look and the surface describing the mechanics do not
// have to share a topology. Presets also carry an optional height and band, which
// is what makes a storey — a building is a stack of two-dimensional surfaces
// rather than one three-dimensional one, which is both cheaper and how buildings
// actually are.

import * as THREE from 'three';

// Vogel's sunflower: a deterministic low-discrepancy disc. Deterministic matters
// — a random sample set makes the weights jitter frame to frame, and a parameter
// that shivers while you stand still is worse than one that steps.
function sunflower( n ) {

	const pts = new Float32Array( n * 2 );
	const golden = Math.PI * ( 3 - Math.sqrt( 5 ) );

	for ( let i = 0; i < n; i ++ ) {

		const r = Math.sqrt( ( i + 0.5 ) / n );
		const a = i * golden;
		pts[ i * 2 ] = Math.cos( a ) * r;
		pts[ i * 2 + 1 ] = Math.sin( a ) * r;

	}

	return pts;

}

const SAMPLES = sunflower( 180 );
const SAMPLE_COUNT = SAMPLES.length / 2;

export class MetaSurface {

	// `keys` are the parameter paths this surface owns, as 'NAMESPACE.field'.
	// Ownership is exclusive on purpose: two surfaces writing one parameter is
	// the thing that makes a layered system impossible to reason about.
	constructor( name, keys, { blend = 1, vertical = 6 } = {} ) {

		this.name = name;
		this.keys = keys;
		this.presets = [];
		this.enabled = true;
		// 0 leaves the sliders alone, 1 hands the parameters entirely to the
		// surface. Anything between is how you audition a surface against the look
		// you were dialling before you placed anything.
		this.blend = blend;
		// Default height band, in metres. A preset only speaks to its own storey.
		this.vertical = vertical;

		this._w = [];
		this._nearest = new Int32Array( SAMPLE_COUNT );

	}

	// Drop the current values of this surface's keys at a point.
	//
	// Reading the *base* — what the sliders say — rather than the live composite
	// is deliberate: the authoring loop is dial, fly, capture, and capturing the
	// composite would fold whatever cues and routes happened to be up into a
	// snapshot that is supposed to describe a place rather than a moment.
	capture( label, x, y, z, readBase ) {

		const values = {};
		for ( const k of this.keys ) values[ k ] = readBase( k );

		const p = { label: label || `${this.name} ${this.presets.length + 1}`,
			x, y, z, band: this.vertical, values };
		this.presets.push( p );
		return p;

	}

	remove( preset ) {

		const i = this.presets.indexOf( preset );
		if ( i >= 0 ) this.presets.splice( i, 1 );

	}

	// Discrete Sibson. Returns the number of contributing presets and fills
	// this._w with their normalised weights.
	weights( x, y, z ) {

		const ps = this.presets;
		const n = ps.length;
		this._w.length = n;
		for ( let i = 0; i < n; i ++ ) this._w[ i ] = 0;
		if ( n === 0 ) return 0;

		// Vertical gating first. A preset on another storey is not a natural
		// neighbour of anything on this one, whatever the plan view says.
		const vg = new Float64Array( n );
		let live = 0;

		for ( let i = 0; i < n; i ++ ) {

			const band = ps[ i ].band || this.vertical;
			const dy = Math.abs( y - ps[ i ].y );
			const g = band <= 0 ? 1 : Math.max( 0, 1 - dy / band );
			vg[ i ] = g * g * ( 3 - 2 * g );
			if ( vg[ i ] > 0 ) live ++;

		}

		if ( live === 0 ) return 0;
		if ( live === 1 ) {

			for ( let i = 0; i < n; i ++ ) if ( vg[ i ] > 0 ) { this._w[ i ] = 1; return 1; }

		}

		// Size the sample disc from the third-nearest preset, which comfortably
		// contains the query's new Voronoi cell without wasting samples on
		// presets that could never be natural neighbours.
		let d1 = Infinity, d2 = Infinity, d3 = Infinity;

		for ( let i = 0; i < n; i ++ ) {

			if ( vg[ i ] <= 0 ) continue;
			const dx = ps[ i ].x - x, dz = ps[ i ].z - z;
			const d = Math.sqrt( dx * dx + dz * dz );
			if ( d < d1 ) { d3 = d2; d2 = d1; d1 = d; }
			else if ( d < d2 ) { d3 = d2; d2 = d; }
			else if ( d < d3 ) d3 = d;

		}

		const radius = Math.max( 0.35, ( isFinite( d3 ) ? d3 : isFinite( d2 ) ? d2 : d1 ) * 1.25 );
		let total = 0;

		for ( let s = 0; s < SAMPLE_COUNT; s ++ ) {

			const sx = x + SAMPLES[ s * 2 ] * radius;
			const sz = z + SAMPLES[ s * 2 + 1 ] * radius;

			// Nearest preset to this sample, weighted by the vertical gate so a
			// half-present storey competes at half strength.
			let best = - 1, bestD = Infinity;

			for ( let i = 0; i < n; i ++ ) {

				if ( vg[ i ] <= 0 ) continue;
				const dx = ps[ i ].x - sx, dz = ps[ i ].z - sz;
				const d = ( dx * dx + dz * dz ) / vg[ i ];
				if ( d < bestD ) { bestD = d; best = i; }

			}

			if ( best < 0 ) continue;

			// Would the query have stolen this sample? That is the whole test.
			const qx = sx - x, qz = sz - z;
			if ( qx * qx + qz * qz < bestD ) { this._w[ best ] ++; total ++; }

		}

		if ( total === 0 ) {

			// Standing exactly on a preset, or degenerately close to one.
			let best = - 1, bestD = Infinity;
			for ( let i = 0; i < n; i ++ ) {

				if ( vg[ i ] <= 0 ) continue;
				const dx = ps[ i ].x - x, dz = ps[ i ].z - z;
				const d = dx * dx + dz * dz;
				if ( d < bestD ) { bestD = d; best = i; }

			}
			if ( best >= 0 ) { this._w[ best ] = 1; return 1; }
			return 0;

		}

		let contributing = 0;
		for ( let i = 0; i < n; i ++ ) {

			if ( this._w[ i ] === 0 ) continue;
			this._w[ i ] /= total;
			contributing ++;

		}

		return contributing;

	}

	// Blend the presets at a point and write into `out` as path -> value.
	evaluate( x, y, z, out, base ) {

		if ( ! this.enabled || this.blend <= 0 ) return 0;
		const contributing = this.weights( x, y, z );
		if ( contributing === 0 ) return 0;

		for ( const k of this.keys ) {

			let v = 0;
			for ( let i = 0; i < this.presets.length; i ++ ) {

				const w = this._w[ i ];
				if ( w > 0 ) v += this.presets[ i ].values[ k ] * w;

			}

			// Toward, not onto, so a surface can be auditioned against the
			// hand-dialled look rather than replacing it outright.
			const from = out.has( k ) ? out.get( k ) : base( k );
			out.set( k, from + ( v - from ) * this.blend );

		}

		return contributing;

	}

	// Which presets are actually speaking, for the readout and the editor.
	influences( threshold = 0.005 ) {

		const out = [];
		for ( let i = 0; i < this.presets.length; i ++ ) {

			if ( this._w[ i ] > threshold ) out.push( { preset: this.presets[ i ], weight: this._w[ i ] } );

		}
		return out.sort( ( a, b ) => b.weight - a.weight );

	}

	// Bake. The output is source, not a save file — same as the tuning export,
	// because a level that lives in a blob nobody can read is a level nobody
	// edits.
	bake() {

		const rows = this.presets.map( p => {

			const vals = Object.entries( p.values )
				.map( ( [ k, v ] ) => `\t\t\t'${k}': ${typeof v === 'number' ? + v.toFixed( 4 ) : v}` )
				.join( ',\n' );

			return `\t{ label: '${p.label}', x: ${+ p.x.toFixed( 2 )}, y: ${+ p.y.toFixed( 2 )}, ` +
				`z: ${+ p.z.toFixed( 2 )}, band: ${+ ( p.band || this.vertical ).toFixed( 1 )}, values: {\n${vals}\n\t\t} }`;

		} );

		return `// ${this.name} — ${this.presets.length} preset(s)\nexport const ${
			this.name.toUpperCase().replace( /[^A-Z0-9]/g, '_' ) }_PRESETS = [\n${rows.join( ',\n' )}\n];\n`;

	}

	load( presets ) {

		this.presets = presets.map( p => Object.assign( {}, p ) );

	}

}

// The markers. An editor that cannot show you where you dropped something is a
// text file with extra steps.
export class SurfaceMarkers {

	constructor( scene, max = 128 ) {

		this.max = max;
		this.pos = new Float32Array( max * 3 );
		this.col = new Float32Array( max * 3 );

		const geo = new THREE.BufferGeometry();
		geo.setAttribute( 'position', new THREE.BufferAttribute( this.pos, 3 ) );
		geo.setAttribute( 'color', new THREE.BufferAttribute( this.col, 3 ) );
		geo.setDrawRange( 0, 0 );

		this.points = new THREE.Points( geo, new THREE.PointsMaterial( {
			size: 22, sizeAttenuation: false, vertexColors: true,
			depthTest: false, transparent: true, opacity: 0.95
		} ) );
		this.points.frustumCulled = false;
		this.points.renderOrder = 999;
		this.points.visible = false;
		scene.add( this.points );
		this.geo = geo;

	}

	// Colour by live weight, so the surface's influence is visible while flying
	// it rather than only in a list.
	update( surfaces ) {

		let n = 0;

		for ( const s of surfaces ) {

			if ( ! s.enabled ) continue;

			for ( let i = 0; i < s.presets.length && n < this.max; i ++ ) {

				const p = s.presets[ i ];
				const w = s._w[ i ] || 0;
				this.pos[ n * 3 ] = p.x; this.pos[ n * 3 + 1 ] = p.y; this.pos[ n * 3 + 2 ] = p.z;
				this.col[ n * 3 ] = 0.25 + w * 0.75;
				this.col[ n * 3 + 1 ] = 0.15 + w * 0.55;
				this.col[ n * 3 + 2 ] = 0.85 - w * 0.5;
				n ++;

			}

		}

		this.geo.setDrawRange( 0, n );
		this.geo.attributes.position.needsUpdate = true;
		this.geo.attributes.color.needsUpdate = true;

	}

}
