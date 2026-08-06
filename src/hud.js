// Debug readout.
//
// Explicitly a development instrument, not a HUD. §26 and §47.3 conclude the
// shipping game has no HUD at all — the held-object orbit is the self-readout —
// so nothing in here should be mistaken for interface design. It exists to make
// the numbers behind the feel visible while tuning them.

export class Hud {

	constructor( el, reticle ) {

		this.el = el;
		this.reticle = reticle;
		this.frames = 0;
		this.acc = 0;
		this.fps = 0;
		this._reticleClass = '';

	}

	update( dt, data ) {

		this.frames ++;
		this.acc += dt;

		if ( this.acc >= 0.35 ) {

			this.fps = this.frames / this.acc;
			this.frames = 0;
			this.acc = 0;

		}

		const p = data.probe;
		let cls = '';

		if ( p ) cls = p.kind === 'panel' ? 'weak' : 'probe';
		if ( cls !== this._reticleClass ) { this.reticle.className = cls; this._reticleClass = cls; }

		let probeLine = '—';

		if ( p && p.kind === 'panel' ) {

			const pn = p.panel;
			const state = [ 'INTACT', 'BREACHED', 'OPEN' ][ pn.state ];

			if ( pn.activated ) {

				const live = data.panels[ pn.id ];
				probeLine = `WEAK PANEL   ${state}   ${live.joints}/${live.totalJoints} welds` +
					`   ${live.open}/${live.cells} cells out` +
					( live.loose > 0 ? `   ${live.loose} unsupported` : '' );

			} else {

				const pct = Math.min( 99, Math.round( pn.damage / 1.1 ) );
				probeLine = `WEAK PANEL   INTACT   ${pct}% to failure`;

			}

		} else if ( p && p.kind === 'body' ) {

			const kind = [ 'tile', 'concrete', 'glass', 'steel' ][ p.material ] || '?';
			probeLine = `${kind}  ${p.mass.toFixed( 1 )}kg${p.asleep ? '  (settled)' : ''}`;

		}

		const wattBar = this._bar( Math.min( 1, data.watts / data.wattScale ), 18 );

		// The pool is the inventory and the fuel gauge at once. Eventually this is
		// the rim of the frame silting up (§44-adjacent, "mud on a camera"); until
		// that exists it is four numbers, and the selected one is marked because
		// that is the only part the player actually chooses.
		const disc = data.pool ? Array.from( data.pool, ( kg, k ) => {

			const name = data.materialNames[ k ];
			const cell = `${name} ${kg.toFixed( 0 )}`;
			return k === data.selected ? `<b>[${cell}]</b>` : `<span style="opacity:.45">${cell}</span>`;

		} ).join( '  ' ) : '';

		const sat = data.capacity > 0 ? data.poolMass / data.capacity : 0;

		this.el.innerHTML =
			`<b>${this.fps.toFixed( 0 ).padStart( 3 )}</b> fps   tier <b>${data.tier}</b>   dpr <b>${data.dpr.toFixed( 2 )}</b>\n` +
			`bodies <b>${data.active}</b> awake  <b>${data.asleep}</b> settled  <b>${data.contacts}</b> contacts  x<b>${data.substeps}</b>\n` +
			`\n` +
			`draw   ${wattBar} <b>${data.watts.toFixed( 0 ).padStart( 4 )}</b> W\n` +
			`disc   ${this._bar( sat, 18 )} <b>${data.poolMass.toFixed( 0 )}</b>/${data.capacity | 0} kg` +
				`${data.stalled ? `   <span class="warn">FULL</span>` : '' }\n` +
			`       ${disc}\n` +
			`funnel <b>${data.inFunnel}</b> in draw   <b>${data.consumed}</b> eaten\n` +
			`speed  <b>${data.speed.toFixed( 1 )}</b> m/s${data.dilation > 0.01 ? `   <span class="warn">dilated 1:${( 1 / Math.max( 0.02, 1 - data.dilation ) ).toFixed( 0 )}</span>` : '' }\n` +
			`light  ${this._bar( data.light, 18 )} <b>${( data.light * 100 ).toFixed( 0 )}</b>%\n` +
			`dust   ${this._bar( Math.min( 1, data.suspended / 12 ), 18 )} <b>${data.dust}</b> aloft\n` +
			`\n` +
			`panels ${data.panels.map( p => p.active
				? `<b>${p.state}</b> ${p.open}/${p.cells}`
				: `<span style="opacity:.45">intact</span>` ).join( '   ' )}\n` +
			`\n` +
			`probe  ${probeLine}`;

	}

	_bar( v, width ) {

		const n = Math.round( Math.max( 0, Math.min( 1, v ) ) * width );
		return '▓'.repeat( n ) + '░'.repeat( width - n );

	}

}
