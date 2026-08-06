// Input.
//
// §51.7 flags the input budget as unresolved and warns it must not be discovered
// late: six axes, acquire, three matter sinks, a continuous dilation dial, probe,
// annex, cut, vent — more than a controller has. This prototype deliberately
// binds only what the killing test needs, so the shortfall stays visible instead
// of being papered over with modifier keys.

const DEFAULTS = {
	forward: [ 'KeyW' ],
	back: [ 'KeyS' ],
	left: [ 'KeyA' ],
	right: [ 'KeyD' ],
	up: [ 'Space' ],
	down: [ 'ShiftLeft', 'ShiftRight', 'KeyC' ],
	rollLeft: [ 'KeyQ' ],
	rollRight: [ 'KeyE' ],
	// Arrow keys drive pitch and yaw. Descent bound rotation to the keyboard as
	// well as the stick, and it matters here for the same reason: you cannot
	// hold a slow, exact turn with a mouse.
	pitchUp: [ 'ArrowUp' ],
	pitchDown: [ 'ArrowDown' ],
	yawLeft: [ 'ArrowLeft' ],
	yawRight: [ 'ArrowRight' ],
	burn: [ 'ControlLeft', 'ControlRight' ],
	probe: [ 'KeyF' ],
	vent: [ 'KeyR' ],
	reset: [ 'KeyG' ],
	copyTuning: [ 'KeyP' ]
};

export class Input {

	constructor( domElement, gate ) {

		this.dom = domElement;
		this.gate = gate;
		this.keys = Object.create( null );
		this.locked = false;

		this.mouseX = 0;
		this.mouseY = 0;
		this.intake = false;    // LMB held — the funnel is open
		this.fire = false;      // RMB edge
		this.fireHeld = false;
		// Wheel selects which material fires. It is the one binding left that is
		// both free and already means "switch what you are holding" to everyone
		// who has played a shooter, which is the whole reason the inventory needs
		// no menu (§51.7 has no room for one).
		this.wheel = 0;

		this.state = {
			forward: false, back: false, left: false, right: false,
			up: false, down: false, rollLeft: false, rollRight: false,
			pitchUp: false, pitchDown: false, yawLeft: false, yawRight: false,
			burn: false, mouseX: 0, mouseY: 0
		};

		// Edges are latched at the event, not sampled per frame. Polling
		// `down && !wasDown` once a frame silently drops any tap shorter than a
		// frame — at 30fps that is a 33ms window, and a quick keypress loses.
		this._edges = Object.create( null );
		this._latched = Object.create( null );

		addEventListener( 'keydown', e => {

			// Never swallow the browser's own escapes.
			if ( e.code === 'F5' || e.code === 'F12' || ( e.metaKey || e.ctrlKey ) && e.code === 'KeyR' ) return;

			// Latch on the transition only, so auto-repeat does not re-fire it.
			if ( this.keys[ e.code ] !== true ) {

				for ( const action in DEFAULTS ) {

					if ( DEFAULTS[ action ].indexOf( e.code ) !== - 1 ) this._latched[ action ] = true;

				}

			}

			this.keys[ e.code ] = true;
			if ( e.code.startsWith( 'Arrow' ) || e.code === 'Space' ) e.preventDefault();
			if ( this.locked && e.code !== 'Tab' ) e.preventDefault();

		} );

		addEventListener( 'keyup', e => { this.keys[ e.code ] = false; } );

		addEventListener( 'blur', () => {

			this.keys = Object.create( null );
			this._latched = Object.create( null );
			this.intake = false;
			this.fireHeld = false;
			this.wheel = 0;

		} );

		domElement.addEventListener( 'mousedown', e => {

			if ( ! this.locked ) return;
			if ( e.button === 0 ) this.intake = true;
			if ( e.button === 2 ) this.fireHeld = true;
			e.preventDefault();

		} );

		addEventListener( 'mouseup', e => {

			if ( e.button === 0 ) this.intake = false;
			if ( e.button === 2 ) { this.fire = this.fireHeld; this.fireHeld = false; }

		} );

		domElement.addEventListener( 'contextmenu', e => e.preventDefault() );

		// Alt is the tiebreak, and it is worth naming why there is one. §51.7 warned
		// the input budget was over-subscribed and must not be discovered late;
		// this is where it surfaces. Two continuous dials — which material fires,
		// and how far time is wound down — both want the wheel, and there is no
		// third good home for either. Bare wheel goes to the material because that
		// is the binding a shooter player already has, and dilation takes the
		// modifier because it is a dial you set, not one you ride.
		addEventListener( 'wheel', e => {

			if ( ! this.locked ) return;
			if ( ! e.altKey ) this.wheel += e.deltaY;
			e.preventDefault();

		}, { passive: false } );

		addEventListener( 'mousemove', e => {

			if ( ! this.locked ) return;
			this.mouseX += e.movementX;
			this.mouseY += e.movementY;

		} );

		document.addEventListener( 'pointerlockchange', () => {

			this.locked = document.pointerLockElement === domElement;
			gate.classList.toggle( 'hidden', this.locked );
			// Once you have flown once you do not need the key list again. From
			// here the gate is a hint, not a curtain — it stops covering the scene
			// and stops swallowing clicks, so Escape gives you the cursor over a
			// running world with the tuning panel usable.
			if ( this.locked ) gate.classList.add( 'compact' );

			if ( ! this.locked ) {

				this.keys = Object.create( null );
				// Escape while holding the funnel open would otherwise leave it
				// open — mouseup never arrives once the pointer is gone.
				this.intake = false;
				this.fireHeld = false;

			}

		} );

		gate.addEventListener( 'click', () => domElement.requestPointerLock() );
		domElement.addEventListener( 'click', () => {

			if ( ! this.locked ) domElement.requestPointerLock();

		} );

	}

	down( action ) {

		const codes = DEFAULTS[ action ];
		if ( ! codes ) return false;
		for ( let i = 0; i < codes.length; i ++ ) if ( this.keys[ codes[ i ] ] === true ) return true;
		return false;

	}

	// True on the frame the action goes down.
	pressed( action ) {

		return this._edges[ action ] === true;

	}

	// Sample once per frame; consumes accumulated mouse delta.
	sample() {

		const s = this.state;

		this._edges = this._latched;
		this._latched = Object.create( null );

		s.forward = this.down( 'forward' );
		s.back = this.down( 'back' );
		s.left = this.down( 'left' );
		s.right = this.down( 'right' );
		s.up = this.down( 'up' );
		s.down = this.down( 'down' );
		s.rollLeft = this.down( 'rollLeft' );
		s.rollRight = this.down( 'rollRight' );
		s.pitchUp = this.down( 'pitchUp' );
		s.pitchDown = this.down( 'pitchDown' );
		s.yawLeft = this.down( 'yawLeft' );
		s.yawRight = this.down( 'yawRight' );
		s.burn = this.down( 'burn' );

		s.mouseX = this.mouseX;
		s.mouseY = this.mouseY;
		this.mouseX = 0;
		this.mouseY = 0;

		s.intake = this.intake;
		s.fire = this.fire;
		this.fire = false;

		// One step per sample regardless of how far the wheel spun, so a flicked
		// trackpad advances one material rather than four.
		s.cycle = this.wheel > 1 ? 1 : this.wheel < - 1 ? - 1 : 0;
		this.wheel = 0;

		return s;

	}

}
