// The patch bay.
//
// Hydra's own syntax is "inspired by analog modular synthesis, in which chaining
// or patching a set of transformations together generates a visual result". The
// half that metaphor implies and a slider panel does not is *routing*: a source
// is patched to a destination with an amount, and the destination does not know
// or care where the signal came from.
//
// That is what this is. Every number the look is made of — hydra's chain, the
// scan's density and ramp, the post grade — is a destination. Everything the
// game knows about itself is a source: speed, how full the disc is, how much
// power is being drawn, how close the nearest threat is, how badly the room
// nearby has been eroded, how much light is left, where you are. Routes are
// data, so a look is a list rather than a branch in the render loop.
//
// Three properties this has that hard-wiring does not:
//
//   * Routes are additive around whatever the sliders are set to. A route offsets
//     the dialled value rather than replacing it, so tuning by hand and
//     modulating by state do not fight — which is the thing that makes the panel
//     still worth having once any of this is live.
//   * Every source has its own attack and release. A hit is two frames long and a
//     raw route on it produces a click; separate rise and fall times turn the
//     same event into a swell and a decay, which is the entire difference between
//     a reactive look and a flickering one.
//   * Zones are the same mechanism with a different addressing scheme. A region
//     of space carries parameter *offsets* and a feather distance, so flying into
//     one cross-fades rather than switching, and several overlapping zones sum.
//
// Nothing here knows what hydra is. It reads numbers out of the world and writes
// numbers into registered objects, which is why it can drive the scan and the
// post grade with the same routes that drive the feedback loop.

// Shaping applied between a source and its destination. Not decoration: a linear
// route from a value that spends most of its time near zero does nothing
// visible, and the same route through `gate` is a switch.
export const CURVES = {

	linear: v => v,
	square: v => v * v,
	root: v => Math.sqrt( Math.max( 0, v ) ),
	invert: v => 1 - v,
	// Dead below the knee, full above it. For "when this actually matters".
	gate: v => ( v > 0.5 ? 1 : 0 ),
	// Peaks in the middle and falls off at both ends, so a route can fire on
	// *transition* rather than on magnitude.
	band: v => 1 - Math.abs( v * 2 - 1 ),
	pulse: v => Math.sin( v * Math.PI )

};

export class Source {

	// `read` is a function of the state object. `attack` and `release` are time
	// constants in seconds; zero on either is instant in that direction.
	constructor( name, read, { attack = 0.08, release = 0.5, scale = 1 } = {} ) {

		this.name = name;
		this.read = read;
		this.attack = attack;
		this.release = release;
		this.scale = scale;
		this.raw = 0;
		this.value = 0;

	}

	update( state, dt ) {

		let v = this.read( state );
		if ( ! Number.isFinite( v ) ) v = 0;
		this.raw = Math.max( 0, Math.min( 1, v * this.scale ) );

		const rising = this.raw > this.value;
		const tau = rising ? this.attack : this.release;
		const k = tau > 1e-4 ? 1 - Math.exp( - dt / tau ) : 1;
		this.value += ( this.raw - this.value ) * k;

		return this.value;

	}

}

export class ModMatrix {

	// `targets` maps a namespace to the object holding those numbers, e.g.
	// { HYDRA, SCAN, POST }. Destinations are addressed as 'HYDRA.kaleid'.
	constructor( targets ) {

		this.targets = targets;
		this.sources = new Map();
		this.routes = [];
		this.zones = [];
		this.enabled = true;

		// Whatever the sliders say, captured fresh each frame *before* anything is
		// written. Routes add to this rather than to last frame's result, or every
		// route would integrate itself into a runaway over a few seconds.
		this._base = new Map();
		this._touched = new Set();

	}

	addSource( name, read, opts ) {

		this.sources.set( name, new Source( name, read, opts ) );
		return this;

	}

	// from: source name. to: 'NAMESPACE.key'. amount is in the destination's own
	// units, so a route to `kaleid` of 8 means "up to eight extra sides".
	route( from, to, amount, curve = 'linear' ) {

		this.routes.push( { from, to, amount, curve, on: true } );
		return this;

	}

	// A region of space carrying parameter offsets. `feather` is how far outside
	// the radius the influence takes to fall to nothing, so a zone is a gradient
	// rather than a trigger — flying across a boundary should be a transition you
	// notice happening, not a frame where the world changes.
	zone( name, { x, y, z, radius, feather = 4, set = {} } ) {

		this.zones.push( { name, x, y, z, radius, feather, set, weight: 0, on: true } );
		return this;

	}

	_resolve( path ) {

		const dot = path.indexOf( '.' );
		if ( dot < 0 ) return null;
		const obj = this.targets[ path.slice( 0, dot ) ];
		return obj ? { obj, key: path.slice( dot + 1 ) } : null;

	}

	// Snapshot the dialled values for everything any route or zone can write, so
	// the modulation is an offset from the panel rather than a replacement for it.
	_capture() {

		this._touched.clear();

		for ( const r of this.routes ) this._touched.add( r.to );
		for ( const z of this.zones ) for ( const k in z.set ) this._touched.add( k );

		for ( const path of this._touched ) {

			if ( this._base.has( path ) ) continue;
			const t = this._resolve( path );
			if ( t ) this._base.set( path, t.obj[ t.key ] );

		}

	}

	// Call whenever the panel is dragged, so the new hand-set value becomes the
	// value modulation works around instead of being overwritten by the old one.
	rebase() {

		this._base.clear();

	}

	update( state, dt ) {

		if ( ! this.enabled ) return;

		this._capture();

		for ( const s of this.sources.values() ) s.update( state, dt );

		// Start from the dialled value for every destination in play.
		const acc = new Map();
		for ( const path of this._touched ) acc.set( path, this._base.get( path ) || 0 );

		// Zones first: they set the local ground that routes then modulate around.
		for ( const z of this.zones ) {

			if ( ! z.on ) { z.weight = 0; continue; }

			const d = Math.hypot( state.x - z.x, state.y - z.y, state.z - z.z );
			const w = d <= z.radius ? 1
				: d >= z.radius + z.feather ? 0
					: 1 - ( d - z.radius ) / z.feather;

			// Smoothstep, so a boundary crossing eases rather than ramping
			// linearly into a corner.
			z.weight = w * w * ( 3 - 2 * w );
			if ( z.weight <= 0 ) continue;

			for ( const k in z.set ) acc.set( k, ( acc.get( k ) || 0 ) + z.set[ k ] * z.weight );

		}

		for ( const r of this.routes ) {

			if ( ! r.on ) continue;
			const src = this.sources.get( r.from );
			if ( ! src ) continue;
			const shaped = ( CURVES[ r.curve ] || CURVES.linear )( src.value );
			acc.set( r.to, ( acc.get( r.to ) || 0 ) + shaped * r.amount );

		}

		for ( const [ path, v ] of acc ) {

			const t = this._resolve( path );
			if ( t ) t.obj[ t.key ] = v;

		}

	}

	// For the readout: which sources are actually doing something right now.
	active( threshold = 0.02 ) {

		const out = [];
		for ( const s of this.sources.values() ) if ( s.value > threshold ) out.push( s );
		return out.sort( ( a, b ) => b.value - a.value );

	}

	activeZones() {

		return this.zones.filter( z => z.weight > 0.01 );

	}

}
