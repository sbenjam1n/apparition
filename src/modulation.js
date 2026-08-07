// The patch bay.
//
// Hydra's syntax is "inspired by analog modular synthesis, in which chaining or
// patching a set of transformations together generates a visual result". The
// half that metaphor implies and a slider panel does not is *routing*: a source
// is patched to a destination with an amount, and the destination neither knows
// nor cares where the signal came from.
//
// Two rules, and both of them are reactions to getting it wrong once already.
//
// **Nothing is clamped.** The first version guarded parameters against ranges I
// had invented, and that is exactly backwards — I cannot see the screen, so a
// limit I choose is a guess wearing a hard hat, and a limit that silently eats
// a route is harder to debug than the runaway it hides. Full range, past the
// edge, on purpose.
//
// **Everything is separable.** The reason a runaway was unfindable was not that
// it was subtle, it is that the composite was the only thing on show. Three
// numbers summing to 1.11 look exactly like one number that is 1.11. `explain()`
// returns the base and every contribution by name, so the sum is legible before
// it is a problem — which is the actual fix, and the only one that survives
// somebody adding a route I never anticipated.
//
// The layering, in order:
//
//   base       whatever the sliders say, re-read every frame
//   surfaces   blended toward — Bencina metasurfaces over placed presets.
//              Absolute, because a place says what the look *is*.
//   routes     added — source x curve x amount. Relative, because a route says
//              "and lean it this way".
//
// There is no zone system and no cue system. Zones were spheres with a radius
// and a feather, which a metasurface does better and without the two hand-tuned
// numbers per region; cues were a layer nothing needed yet. Both are gone rather
// than disabled, because a system with a switched-off subsystem in it is a
// system nobody can hold in their head.
//
// Nothing here knows what hydra is. It reads numbers out of the world and writes
// numbers into registered objects, which is why the same routes drive the
// feedback chain, the scan and the flight model.

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
	//
	// Two of them rather than one because an event is short and a response should
	// not be. A hit is two frames long, and a route straight off it clicks;
	// separate rise and fall times make the same event a swell and a decay.
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
		this.surfaces = [];
		this.enabled = true;

		// Whatever the sliders say, captured fresh each frame *before* anything is
		// written. Routes add to this rather than to last frame's result, or every
		// route would integrate itself into a runaway over a few seconds.
		this._base = new Map();
		this._touched = new Set();
		// Last frame's breakdown, kept so the readout costs nothing to produce.
		this._explain = new Map();

	}

	// --- open for extension --------------------------------------------------
	//
	// Sources, surfaces and routes are all added from outside. Nothing in here is
	// a list of the things this particular game happens to have.

	addSource( name, read, opts ) {

		this.sources.set( name, new Source( name, read, opts ) );
		return this;

	}

	surface( ms ) {

		this.surfaces.push( ms );
		return this;

	}

	// from: source name. to: 'NAMESPACE.key'. amount is in the destination's own
	// units, so a route to `kaleid` of 8 means "up to eight extra sides".
	route( from, to, amount, curve = 'linear' ) {

		const r = { from, to, amount, curve, on: true, contribution: 0 };
		this.routes.push( r );
		return r;

	}

	unroute( r ) {

		const i = this.routes.indexOf( r );
		if ( i >= 0 ) this.routes.splice( i, 1 );

	}

	// Public, because the panel builds its sliders from the same paths the routes
	// address and there should be exactly one place that knows how to read one.
	resolve( path ) {

		const dot = path.indexOf( '.' );
		if ( dot < 0 ) return null;
		const obj = this.targets[ path.slice( 0, dot ) ];
		return obj ? { obj, key: path.slice( dot + 1 ) } : null;

	}

	// Snapshot the dialled values for everything any route or surface can write,
	// so modulation is an offset from the panel rather than a replacement for it.
	_capture() {

		this._touched.clear();

		for ( const r of this.routes ) this._touched.add( r.to );

		// An empty surface claims nothing. Otherwise every parameter it *could*
		// own turns up in the readout writing its own value back to itself, and a
		// readout that lists sixty inert rows is one nobody reads.
		for ( const ms of this.surfaces ) {

			if ( ! ms.enabled || ms.presets.length === 0 || ms.blend <= 0 ) continue;
			for ( const k of ms.keys ) this._touched.add( k );

		}

		for ( const path of this._touched ) {

			if ( this._base.has( path ) ) continue;
			const t = this.resolve( path );
			if ( t ) this._base.set( path, t.obj[ t.key ] );

		}

	}

	// What the panel calls when a slider is dragged. The value passed is the one
	// the widget just wrote, which is the base by definition — the hand-set number,
	// before anything is added to it.
	//
	// This has to be explicit rather than "clear the cache and re-read". Re-reading
	// picks up last frame's *composite*, so on a routed parameter every drag would
	// fold whatever the modulation happened to be doing into the new base, and a
	// slider nudged repeatedly while a route was up would ratchet upward with
	// nothing on screen to say why. That is the same failure as the runaway, one
	// layer down.
	setBase( path, value ) {

		this._base.set( path, value );

	}

	// Adopt the current live values as the base, wholesale. For anything routes are
	// writing, the routes' own contributions are subtracted back off first — every
	// one of them is recorded by name, so what the base must have been is exactly
	// recoverable, and the operation is idempotent instead of adding the whole
	// patch to the base every time it is called.
	//
	// A surface is not subtracted, because a surface is absolute: it replaces the
	// base rather than adding to it, so there is nothing in the live value that
	// came from underneath.
	rebase() {

		const adopted = new Map();

		for ( const path of this._touched ) {

			const t = this.resolve( path );
			if ( ! t ) continue;

			let v = t.obj[ t.key ];
			for ( const r of this._explain.get( path ) || [] ) v -= r.contribution;
			adopted.set( path, v );

		}

		this._base.clear();
		for ( const [ path, v ] of adopted ) this._base.set( path, v );

	}

	base( path ) {

		if ( ! this._base.has( path ) ) {

			const t = this.resolve( path );
			if ( t ) this._base.set( path, t.obj[ t.key ] );

		}
		return this._base.get( path ) || 0;

	}

	update( state, dt ) {

		if ( ! this.enabled ) return;

		this._capture();
		for ( const s of this.sources.values() ) s.update( state, dt );

		const acc = new Map();
		for ( const path of this._touched ) acc.set( path, this._base.get( path ) || 0 );

		// Surfaces: absolute. Natural-neighbour weights are a partition of unity,
		// so a surface with coverage fully determines what it owns — where you are
		// is the ground everything else is relative to.
		const readBase = k => this._base.get( k ) || 0;
		for ( const ms of this.surfaces ) ms.evaluate( state.x, state.y, state.z, acc, readBase );

		// Routes: additive, and every one of them recorded by name. Keeping the
		// contribution rather than only the sum is the difference between a
		// runaway you can point at and one you can only watch.
		this._explain.clear();

		for ( const r of this.routes ) {

			r.contribution = 0;
			if ( ! r.on ) continue;

			const src = this.sources.get( r.from );
			if ( ! src ) continue;

			const shaped = ( CURVES[ r.curve ] || CURVES.linear )( src.value );
			r.contribution = shaped * r.amount;
			acc.set( r.to, ( acc.get( r.to ) || 0 ) + r.contribution );

			let list = this._explain.get( r.to );
			if ( ! list ) this._explain.set( r.to, list = [] );
			list.push( r );

		}

		// Written straight through. No clamp — see the header.
		for ( const [ path, v ] of acc ) {

			const t = this.resolve( path );
			if ( t ) t.obj[ t.key ] = v;

		}

	}

	// The instrument. base + every named contribution + the total that was
	// actually written, for one destination.
	explain( path ) {

		const base = this._base.has( path ) ? this._base.get( path ) : this.base( path );
		const t = this.resolve( path );
		const contributions = ( this._explain.get( path ) || [] )
			.filter( r => Math.abs( r.contribution ) > 1e-9 )
			.map( r => ( { from: r.from, curve: r.curve, amount: r.amount, value: r.contribution } ) )
			.sort( ( a, b ) => Math.abs( b.value ) - Math.abs( a.value ) );

		// Only a surface that is actually speaking. Reporting one that merely owns
		// the key would put the word "absolute" next to every parameter of an empty
		// surface, which is the readout telling you something is writing when the
		// thing that would write it has nothing to say.
		let surface = null;

		for ( const ms of this.surfaces ) {

			if ( ! ms.enabled || ms.presets.length === 0 || ms.blend <= 0 ) continue;
			if ( ms.keys.indexOf( path ) >= 0 ) surface = ms.name;

		}

		return { path, base, surface, contributions,
			total: t ? t.obj[ t.key ] : base };

	}

	// Every destination anything is currently writing to, so a readout can be
	// built without knowing what routes exist.
	written() {

		return [ ...this._touched ];

	}

	// For the readout: which sources are actually doing something right now.
	active( threshold = 0.02 ) {

		const out = [];
		for ( const s of this.sources.values() ) if ( s.value > threshold ) out.push( s );
		return out.sort( ( a, b ) => b.value - a.value );

	}

}
