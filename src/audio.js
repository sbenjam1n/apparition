// Procedural impact audio.
//
// §23.6 lists "a good impact sound" alongside mass and force feedback as one of
// the three things that make physics satisfying, and §51.8 flags audio as
// currently mis-filed as art direction when it is the primary feedback channel
// for an invisible protagonist in an unlit room. So it is a system here, not a
// polish pass — but a small one, and entirely synthesised: no assets to load, no
// decode latency, and impact character comes from the material and the impulse
// rather than from picking a sample.
//
// Each hit is a filtered noise burst (the body) plus a short pitched sine (the
// ring). Tile rings high and dies fast; concrete is broadband and dull; glass
// gets a bright inharmonic pair; steel rings long.

const VOICES = {
	// [ noise centre Hz, noise Q, ring Hz, ring decay s, noise decay s, gain ]
	0: [ 2600, 3.2, 1450, 0.09, 0.055, 0.55 ],   // tile
	1: [ 700, 0.9, 190, 0.05, 0.11, 0.7 ],       // concrete
	2: [ 5200, 5.5, 3100, 0.22, 0.05, 0.5 ],     // glass
	3: [ 1800, 2.0, 620, 0.42, 0.08, 0.6 ]       // steel
};

export class ImpactAudio {

	constructor() {

		this.ctx = null;
		this.master = null;
		this.enabled = true;
		this.volume = 0.5;

		this._noise = null;
		this._budget = 0;
		this._lastHit = 0;

	}

	// Must be called from a user gesture — browsers will not start a context
	// otherwise, and a silent prototype reads as a broken one.
	resume() {

		if ( this.ctx ) { if ( this.ctx.state === 'suspended' ) this.ctx.resume(); return; }

		const Ctx = window.AudioContext || window.webkitAudioContext;
		if ( ! Ctx ) { this.enabled = false; return; }

		this.ctx = new Ctx();
		this.master = this.ctx.createGain();
		this.master.gain.value = this.volume;

		// A little compression so a wall coming apart does not clip, and so a
		// single tile landing in silence is still audible.
		const comp = this.ctx.createDynamicsCompressor();
		comp.threshold.value = - 18;
		comp.ratio.value = 6;
		comp.attack.value = 0.002;
		comp.release.value = 0.14;

		this.master.connect( comp );
		comp.connect( this.ctx.destination );

		// One shared noise buffer, reused by every hit.
		const len = this.ctx.sampleRate * 0.4;
		const buf = this.ctx.createBuffer( 1, len, this.ctx.sampleRate );
		const d = buf.getChannelData( 0 );
		for ( let i = 0; i < len; i ++ ) d[ i ] = Math.random() * 2 - 1;
		this._noise = buf;

		this._room();

	}

	// The room tone: a slow filtered rumble under everything, so silence has a
	// floor. §22.3 — the building's hum is a status readout.
	_room() {

		const ctx = this.ctx;
		const src = ctx.createBufferSource();
		src.buffer = this._noise;
		src.loop = true;

		const lp = ctx.createBiquadFilter();
		lp.type = 'lowpass';
		lp.frequency.value = 110;
		lp.Q.value = 0.6;

		const g = ctx.createGain();
		g.gain.value = 0.055;

		src.connect( lp ); lp.connect( g ); g.connect( this.master );
		src.start();

		this.hum = g;
		this.humFilter = lp;

	}

	// Drive the hum with current draw — chillers spooling, fans changing pitch.
	setLoad( normalised ) {

		if ( ! this.ctx || ! this.hum ) return;
		const t = this.ctx.currentTime;
		this.hum.gain.setTargetAtTime( 0.055 + normalised * 0.09, t, 0.35 );
		this.humFilter.frequency.setTargetAtTime( 110 + normalised * 180, t, 0.4 );

	}

	impact( strength, material = 0, pan = 0 ) {

		if ( ! this.enabled || ! this.ctx || this.ctx.state !== 'running' ) return;

		// Voice budget. A collapsing panel produces dozens of contacts in one
		// frame and playing all of them is both expensive and worse-sounding.
		const now = this.ctx.currentTime;
		if ( now - this._lastHit < 0.012 ) return;
		this._lastHit = now;

		const v = VOICES[ material ] || VOICES[ 0 ];
		const amp = Math.min( 1, strength / 9 ) * v[ 5 ];
		if ( amp < 0.012 ) return;

		const ctx = this.ctx;
		const out = ctx.createGain();
		out.gain.value = 1;

		const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;

		if ( panner ) {

			panner.pan.value = Math.max( - 1, Math.min( 1, pan ) );
			out.connect( panner );
			panner.connect( this.master );

		} else {

			out.connect( this.master );

		}

		// Body.
		const src = ctx.createBufferSource();
		src.buffer = this._noise;
		src.playbackRate.value = 0.7 + Math.random() * 0.6;

		const bp = ctx.createBiquadFilter();
		bp.type = 'bandpass';
		// Harder hits are brighter — the single most convincing cue that a
		// collision had weight behind it.
		bp.frequency.value = v[ 0 ] * ( 0.72 + amp * 0.6 );
		bp.Q.value = v[ 1 ];

		const ng = ctx.createGain();
		ng.gain.setValueAtTime( amp, now );
		ng.gain.exponentialRampToValueAtTime( 0.0008, now + v[ 4 ] * ( 1 + amp ) );

		src.connect( bp ); bp.connect( ng ); ng.connect( out );
		src.start( now );
		src.stop( now + 0.4 );

		// Ring.
		const osc = ctx.createOscillator();
		osc.type = 'sine';
		osc.frequency.setValueAtTime( v[ 2 ] * ( 0.85 + Math.random() * 0.3 ), now );
		osc.frequency.exponentialRampToValueAtTime( v[ 2 ] * 0.72, now + v[ 3 ] );

		const og = ctx.createGain();
		og.gain.setValueAtTime( amp * 0.5, now );
		og.gain.exponentialRampToValueAtTime( 0.0008, now + v[ 3 ] * ( 0.7 + amp ) );

		osc.connect( og ); og.connect( out );
		osc.start( now );
		osc.stop( now + v[ 3 ] * 2 + 0.05 );

	}

	// The sound of letting go: everything resolves at once, in half a second
	// (§22.5). Used on a throw, which is the closest thing this prototype has.
	release( count ) {

		if ( ! this.ctx || this.ctx.state !== 'running' ) return;

		const now = this.ctx.currentTime;
		const ctx = this.ctx;

		const src = ctx.createBufferSource();
		src.buffer = this._noise;

		const hp = ctx.createBiquadFilter();
		hp.type = 'highpass';
		hp.frequency.setValueAtTime( 3200, now );
		hp.frequency.exponentialRampToValueAtTime( 300, now + 0.35 );

		const g = ctx.createGain();
		g.gain.setValueAtTime( Math.min( 0.35, 0.07 * count ), now );
		g.gain.exponentialRampToValueAtTime( 0.0008, now + 0.4 );

		src.connect( hp ); hp.connect( g ); g.connect( this.master );
		src.start( now );
		src.stop( now + 0.5 );

	}

}
