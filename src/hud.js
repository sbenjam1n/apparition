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

			const state = [ 'INTACT', 'STRESSED', 'BLOWN' ][ p.panel.state ];
			const pct = Math.min( 100, Math.round( p.panel.damage / 3.8 ) );
			probeLine = `WEAK PANEL   ${state}  ${pct}%`;

		} else if ( p && p.kind === 'body' ) {

			const kind = [ 'tile', 'concrete', 'glass', 'steel' ][ p.material ] || '?';
			probeLine = `${kind}  ${p.mass.toFixed( 1 )}kg${p.asleep ? '  (settled)' : ''}`;

		}

		const heatBar = this._bar( data.heat / 100, 18 );
		const wattBar = this._bar( Math.min( 1, data.watts / data.wattScale ), 18 );

		this.el.innerHTML =
			`<b>${this.fps.toFixed( 0 ).padStart( 3 )}</b> fps   tier <b>${data.tier}</b>   dpr <b>${data.dpr.toFixed( 2 )}</b>\n` +
			`bodies <b>${data.active}</b> awake  <b>${data.asleep}</b> settled  <b>${data.contacts}</b> contacts\n` +
			`\n` +
			`draw   ${wattBar} <b>${data.watts.toFixed( 0 ).padStart( 4 )}</b> W\n` +
			`heat   ${heatBar} <b>${data.heat.toFixed( 0 ).padStart( 4 )}</b>\n` +
			`held   <b>${data.held}</b>  ${data.load.toFixed( 1 )} kg\n` +
			`speed  <b>${data.speed.toFixed( 1 )}</b> m/s${data.dilation > 0.01 ? `   <span class="warn">dilated 1:${( 1 / Math.max( 0.02, 1 - data.dilation ) ).toFixed( 0 )}</span>` : '' }\n` +
			`light  ${this._bar( data.light, 18 )} <b>${( data.light * 100 ).toFixed( 0 )}</b>%\n` +
			`\n` +
			`probe  ${probeLine}`;

	}

	_bar( v, width ) {

		const n = Math.round( Math.max( 0, Math.min( 1, v ) ) * width );
		return '▓'.repeat( n ) + '░'.repeat( width - n );

	}

}
