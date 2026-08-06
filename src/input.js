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
	releaseOrbit: [ 'KeyR' ],
	reset: [ 'KeyG' ]
};

export class Input {

	constructor( domElement, gate ) {

		this.dom = domElement;
		this.gate = gate;
		this.keys = Object.create( null );
		this.locked = false;

		this.mouseX = 0;
		this.mouseY = 0;
		this.grab = false;      // LMB held
		this.throw = false;     // RMB edge
		this.throwHeld = false;

		this.state = {
			forward: false, back: false, left: false, right: false,
			up: false, down: false, rollLeft: false, rollRight: false,
			pitchUp: false, pitchDown: false, yawLeft: false, yawRight: false,
			burn: false, mouseX: 0, mouseY: 0
		};

		this._edges = Object.create( null );
		this._prev = Object.create( null );

		addEventListener( 'keydown', e => {

			// Never swallow the browser's own escapes.
			if ( e.code === 'F5' || e.code === 'F12' || ( e.metaKey || e.ctrlKey ) && e.code === 'KeyR' ) return;
			this.keys[ e.code ] = true;
			if ( e.code.startsWith( 'Arrow' ) || e.code === 'Space' ) e.preventDefault();
			if ( this.locked && e.code !== 'Tab' ) e.preventDefault();

		} );

		addEventListener( 'keyup', e => { this.keys[ e.code ] = false; } );

		addEventListener( 'blur', () => { this.keys = Object.create( null ); } );

		domElement.addEventListener( 'mousedown', e => {

			if ( ! this.locked ) return;
			if ( e.button === 0 ) this.grab = true;
			if ( e.button === 2 ) this.throwHeld = true;
			e.preventDefault();

		} );

		addEventListener( 'mouseup', e => {

			if ( e.button === 0 ) this.grab = false;
			if ( e.button === 2 ) { this.throw = this.throwHeld; this.throwHeld = false; }

		} );

		domElement.addEventListener( 'contextmenu', e => e.preventDefault() );

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
			if ( ! this.locked ) this.keys = Object.create( null );

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

		for ( const action in DEFAULTS ) {

			const now = this.down( action );
			this._edges[ action ] = now && ! this._prev[ action ];
			this._prev[ action ] = now;

		}

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

		s.grab = this.grab;
		s.throw = this.throw;
		this.throw = false;

		return s;

	}

}
