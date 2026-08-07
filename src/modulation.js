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
// Above the routes sit *scenes*, and the right prior art for those is not a VJ
// bank but a lighting desk cue: a named set of levels with a fade-in time, a
// fade-out time, and a condition that fires it. That is exactly the shape asked
// for — hold fire near a particular place and saturation climbs over a ramp,
// stop and it returns to the resting look over a different, longer ramp. Two
// ramps rather than one is the whole point; a swell that decays at the speed it
// arrived reads as a switch.
//
// The layering, in order, because the order is what makes it behave:
//
//   base      whatever the sliders say, re-read every frame
//   surfaces  blended toward — Bencina metasurfaces, natural-neighbour weights
//             over placed presets. This is what a *place* looks like.
//   scenes    blended toward — absolute targets, weighted by each cue's ramp.
//             Above surfaces, because a cue is an event and an event should be
//             able to overrule where you happen to be standing.
//   zones     added — spatial offsets, feathered, and they sum
//   routes    added — source x amount, optionally gated by a zone's weight
//
// Scenes are absolute and blend; zones and routes are relative and add. That
// distinction is the one that keeps it predictable: a cue says "here is the look",
// a zone and a route say "and lean it this way".
//
// Cross-modulation between areas falls out of one line — every zone is also
// published as a source named `zone:<name>`, so a route can be scaled by where
// you are, and a route in one region can be driven by your distance into
// another. "Speed drives kaleid, but only among the piers" is a route with a
// `via`; "the pool bleeds into the corridor" is a route from one zone's weight to
// a parameter another zone owns.
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

// Trigger helpers. A trigger returns 0..1 rather than a boolean, so a cue can
// come up part-way — which is what makes "near a certain location" a gradient
// instead of a tripwire.
export const WHEN = {

	// A named state flag or number, clamped.
	state: key => st => {

		const v = st[ key ];
		return v === true ? 1 : v === false || v == null ? 0 : Math.max( 0, Math.min( 1, v ) );

	},

	above: ( key, threshold, soft = 0.1 ) => st => {

		const v = st[ key ] || 0;
		return Math.max( 0, Math.min( 1, ( v - threshold ) / Math.max( 1e-4, soft ) ) );

	},

	// How far inside a zone you are, which the matrix publishes as a source.
	near: name => st => st[ `zone:${name}` ] || 0,

	// Multiplicative, so a cue that needs two conditions comes up only as far as
	// the weaker of them. `fire near the pool` should be at half strength when you
	// are half-way into the pool, not on.
	all: ( ...fns ) => st => fns.reduce( ( a, f ) => a * f( st ), 1 ),
	any: ( ...fns ) => st => fns.reduce( ( a, f ) => Math.max( a, f( st ) ), 0 ),
	not: fn => st => 1 - fn( st )

};

// A cue. `set` is absolute — the values the look moves *to* — and `enter` and
// `exit` are the seconds it takes to get there and back.
class Scene {

	constructor( name, { when, set = {}, enter = 1.0, exit = 2.0, hold = 0, priority = 0 } ) {

		this.name = name;
		this.when = when;
		this.set = set;
		this.enter = enter;
		this.exit = exit;
		// Minimum time up once fired. A trigger that is true for one frame — a hit,
		// a shot — would otherwise produce a ramp that reverses before it arrives.
		this.hold = hold;
		this.priority = priority;
		this.on = true;
		this.weight = 0;
		this.target = 0;
		this._held = 0;
		this._peak = 0;

	}

	update( state, dt ) {

		if ( ! this.on ) { this.weight = 0; this.target = 0; return 0; }

		this.target = Math.max( 0, Math.min( 1, this.when( state ) ) );

		// Hold latches the *level the trigger asked for*, not the level reached so
		// far. Holding the current weight instead merely freezes the ramp where it
		// happened to be when the trigger let go — an eight-metre-per-second hit
		// stalled at 24% instead of arriving, which looked like a working cue and
		// was not one.
		if ( this.target > this._peak || this.target > this.weight ) {

			this._held = this.hold;
			this._peak = Math.max( this._peak, this.target );

		} else if ( this._held > 0 ) {

			this._held -= dt;
			if ( this._held <= 0 ) this._peak = 0;

		}

		const goal = this._held > 0 ? Math.max( this.target, this._peak ) : this.target;
		const rising = goal > this.weight;
		const tau = rising ? this.enter : this.exit;

		// Exponential rather than linear. A linear fade arrives with a corner on
		// it, and on a parameter that is already being modulated the corner reads
		// as a glitch rather than as a transition.
		const k = tau > 1e-4 ? 1 - Math.exp( - dt / tau ) : 1;
		this.weight += ( goal - this.weight ) * k;
		if ( this.weight < 1e-4 ) this.weight = 0;

		return this.weight;

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
		this.scenes = [];
		this.surfaces = [];
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
	//
	// `via` names a zone whose weight scales the whole route, which is how a patch
	// becomes local: the same source drives a different parameter, or none, in a
	// different part of the building.
	route( from, to, amount, curve = 'linear', via = null ) {

		this.routes.push( { from, to, amount, curve, via, on: true } );
		return this;

	}

	surface( ms ) {

		this.surfaces.push( ms );
		return this;

	}

	// A cue: absolute levels, a fade in, a fade out, and a condition.
	scene( name, spec ) {

		this.scenes.push( new Scene( name, spec ) );
		this.scenes.sort( ( a, b ) => a.priority - b.priority );
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
		for ( const sc of this.scenes ) for ( const k in sc.set ) this._touched.add( k );
		for ( const ms of this.surfaces ) for ( const k of ms.keys ) this._touched.add( k );

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

		// Zone weights first, and publish them onto the state, because both the
		// scene triggers and the routes want to ask where you are.
		for ( const z of this.zones ) {

			if ( ! z.on ) { z.weight = 0; state[ `zone:${z.name}` ] = 0; continue; }

			const d = Math.hypot( state.x - z.x, state.y - z.y, state.z - z.z );
			const w = d <= z.radius ? 1
				: d >= z.radius + z.feather ? 0
					: 1 - ( d - z.radius ) / z.feather;

			// Smoothstep, so a boundary crossing eases rather than ramping
			// linearly into a corner.
			z.weight = w * w * ( 3 - 2 * w );
			state[ `zone:${z.name}` ] = z.weight;

		}

		for ( const s of this.sources.values() ) s.update( state, dt );
		for ( const sc of this.scenes ) sc.update( state, dt );

		// Start from the dialled value for every destination in play.
		const acc = new Map();
		for ( const path of this._touched ) acc.set( path, this._base.get( path ) || 0 );

		// Surfaces first. Natural-neighbour weights are a partition of unity, so a
		// surface with coverage fully determines the parameters it owns — which is
		// the point: where you are is the ground everything else is relative to.
		const readBase = k => this._base.get( k ) || 0;
		for ( const ms of this.surfaces ) ms.evaluate( state.x, state.y, state.z, acc, readBase );

		// Scenes: blended *toward*, in priority order. Absolute, because a cue's
		// job is to say what the look is rather than to lean on it.
		for ( const sc of this.scenes ) {

			if ( sc.weight <= 0 ) continue;
			for ( const k in sc.set ) {

				const from = acc.has( k ) ? acc.get( k ) : ( this._base.get( k ) || 0 );
				acc.set( k, from + ( sc.set[ k ] - from ) * sc.weight );

			}

		}

		// Zones: added on top of whatever cue is up, so a region still colours a
		// scene rather than being overruled by it.
		for ( const z of this.zones ) {

			if ( z.weight <= 0 ) continue;
			for ( const k in z.set ) acc.set( k, ( acc.get( k ) || 0 ) + z.set[ k ] * z.weight );

		}

		for ( const r of this.routes ) {

			if ( ! r.on ) continue;
			const src = this.sources.get( r.from );
			if ( ! src ) continue;

			// `via` makes the patch local — the route only exists where you are.
			let gate = 1;
			if ( r.via ) {

				const z = this.zones.find( q => q.name === r.via );
				gate = z ? z.weight : 0;

			}

			if ( gate <= 0 ) continue;
			const shaped = ( CURVES[ r.curve ] || CURVES.linear )( src.value );
			acc.set( r.to, ( acc.get( r.to ) || 0 ) + shaped * r.amount * gate );

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

	activeScenes( threshold = 0.01 ) {

		return this.scenes.filter( s => s.weight > threshold )
			.sort( ( a, b ) => b.weight - a.weight );

	}

	// What the sliders say, which is what a metasurface preset captures. Reading
	// the base rather than the composite is what keeps a preset a description of
	// a *place* rather than of a moment that happened to be passing through it.
	base( path ) {

		if ( ! this._base.has( path ) ) {

			const t = this._resolve( path );
			if ( t ) this._base.set( path, t.obj[ t.key ] );

		}
		return this._base.get( path ) || 0;

	}

	// Snapshot the current look as a cue, which is how a scene gets authored:
	// dial it on the panel, then take it.
	capture( name, keys, spec = {} ) {

		const set = {};
		for ( const k of keys ) {

			const t = this._resolve( k );
			if ( t ) set[ k ] = t.obj[ t.key ];

		}
		return this.scene( name, Object.assign( { when: () => 0, set }, spec ) );

	}

}
