// APPARITION — feel test 01.
//
// §29 Phase 0, the killing test: "Is flying, grabbing and throwing heavy objects
// with Newtonian recoil delightful in an empty room — no enemies, no economy, no
// dilation? Answer this in week two, not month eight." Everything in the design
// index is superstructure over that, so this build runs exactly that experiment
// and nothing beyond what is needed to judge it honestly.
//
// What is deliberately absent: enemies, objectives, annexation, containment,
// humans, and any economy that would let a bad flight model hide behind a good
// system. The draw meter is present because the funnel needs *some* cost to
// feel weighted and because a feel test that cannot show you its cost curve
// cannot be tuned. Thermal debt (§5.3) is computed and drives bloom, but it is
// deliberately not on the readout: nothing in this build has a consequence that
// depends on it, and a meter that moves without meaning anything is worse than
// no meter.

import * as THREE from 'three';
import { GUI } from 'lil-gui';

import { AVBDSolver } from './avbd.js';
import { LightRig } from './lighting.js';
import { buildRoom, scatterProps, ROOM, MATERIAL_KIND } from './room.js';
import { DebrisField } from './debris.js';
import { Flight, TUNING } from './flight.js';
import { Input } from './input.js';
import { Accretion, ACC, MATERIAL_NAME } from './accretion.js';
import { Destruction, addTestPanels, PANEL_STATE, PANEL_STATE_NAME } from './destruct.js';
import { DustField } from './dust.js';
import { PostStack, POST } from './fx.js';
import { ImpactAudio } from './audio.js';
import { Hud } from './hud.js';

// --- renderer ---------------------------------------------------------------

const renderer = new THREE.WebGLRenderer( { antialias: false, powerPreference: 'high-performance' } );
renderer.setSize( innerWidth, innerHeight );
document.body.appendChild( renderer.domElement );

const scene = new THREE.Scene();
scene.background = new THREE.Color( 0x04070a );

const camera = new THREE.PerspectiveCamera( 78, innerWidth / innerHeight, 0.05, 140 );

// --- world ------------------------------------------------------------------

const solver = new AVBDSolver( 640 );
solver.gravity = - 9.81;
solver.iterations = 6;

const rig = new LightRig();
const room = buildRoom( scene, rig, solver );
const debris = new DebrisField( scene, rig, solver );

const flight = new Flight( solver );
const accretion = new Accretion( solver, flight, debris );
const destruction = new Destruction( scene, rig, solver, debris );
const panels = addTestPanels( destruction, rig, ROOM );
flight.panels = panels;

const dust = new DustField( scene, rig, {
	min: { x: - ROOM.halfW, y: ROOM.pool.bottom, z: - ROOM.halfD },
	max: { x: ROOM.halfW, y: ROOM.height, z: ROOM.halfD }
}, 900 );

scatterProps( solver, ( i, kind ) => debris.register( i, kind ) );

const post = new PostStack( renderer, scene, camera );
const audio = new ImpactAudio();
const hud = new Hud( document.getElementById( 'hud' ), document.getElementById( 'reticle' ) );
const input = new Input( renderer.domElement, document.getElementById( 'gate' ) );

document.getElementById( 'gate' ).addEventListener( 'click', () => audio.resume(), { once: true } );

// --- reactions --------------------------------------------------------------

const _camDir = new THREE.Vector3();

solver.onImpact = ( i, speed, x, y, z, material ) => {

	// Pan by which side of the view the hit landed on. Cheap, and with no visible
	// protagonist it is most of the spatial information the player gets.
	_camDir.set( 1, 0, 0 ).applyQuaternion( flight.viewQuaternion );
	const pan = Math.max( - 1, Math.min( 1,
		( ( x - flight.viewPosition.x ) * _camDir.x +
		  ( y - flight.viewPosition.y ) * _camDir.y +
		  ( z - flight.viewPosition.z ) * _camDir.z ) * 0.2 ) );

	audio.impact( speed, material, pan );

	// A heavy hit near a fixture makes it stutter. §22.4: your own noise is your
	// liability, and here it is visible as well as audible.
	if ( speed > 5 ) {

		for ( const s of rig.strips ) {

			if ( s.dead ) continue;
			const d = Math.hypot( s.a.x - x, s.a.y - y, s.a.z - z );
			if ( d < 6 ) rig.pulse( s, Math.min( 0.5, speed * 0.05 ) );

		}

	}

};

// A joint letting go is the atomic destruction event now. Everything downstream
// — dust, sound, the aperture recount — hangs off the lambda that broke it, so a
// weld that gave up quietly and one that was torn out do not produce the same
// plume or the same noise.
solver.onFracture = ( j, force, x, y, z, group ) => {

	const panel = destruction.panelOfGroup( group );
	const n = panel ? panel.normal : { x: 0, y: 1, z: 0 };
	dust.puff( x, y, z, force, n.x, n.y, n.z );

	audio.impact( 1.5 + Math.min( 7, force / 3200 ), MATERIAL_KIND.CONCRETE, 0 );
	destruction.onFracture( group );

};

destruction.onActivate = panel => {

	audio.release( 6 );
	for ( const s of rig.strips ) rig.pulse( s, 0.3, 3 );
	// Fourth register (§48.3): shape only, no colour. A wall giving way should
	// be felt in the room around it before it is seen in the wall itself.
	rig.shockwave( panel.center.x, panel.center.y, panel.center.z, 0.11, 11, 20 );

};

destruction.onStateChange = ( panel, prev ) => {

	if ( panel.state === PANEL_STATE.OPEN ) {

		audio.release( 10 );
		rig.shockwave( panel.center.x, panel.center.y, panel.center.z, 0.16, 13, 26 );
		// The reserved chroma channel (§44.9), poked once at low amplitude so it
		// stays wired and testable. Not a look, and never on anything routine.
		post.erase( 0.3 );

	}

};

// Consumption is silent geometry unless it is heard. A short material-coloured
// tick per body eaten is enough to tell a bench from a shard without a readout.
accretion.onConsume = ( kind, mass, x, y, z ) => {

	audio.impact( 0.5 + Math.min( 3.2, mass * 0.02 ), kind, 0 );
	dust.puff( x, y, z, 220 + mass * 3, 0, 1, 0 );

};

accretion.onFire = ( kind, count, speed ) => audio.release( count + Math.min( 6, speed ) );
accretion.onVent = dumped => audio.release( 4 + Math.min( 8, dumped * 0.01 ) );

// --- quality governor -------------------------------------------------------
//
// A 2019 MacBook is anything from an Iris Plus 645 to a Radeon Pro 5500M, a
// range of roughly 6x. Rather than target the floor and look cheap on the
// ceiling, start optimistic and step down on sustained frame time. Steps are
// ordered cheapest-look-cost first: volumetric taps, then resolution, then
// solver iterations, then bloom.

const TIERS = [
	{ dpr: 1.00, volumetric: 3, iterations: 6, substeps: 3, bloom: true },
	{ dpr: 1.00, volumetric: 2, iterations: 5, substeps: 3, bloom: true },
	{ dpr: 0.85, volumetric: 1, iterations: 4, substeps: 3, bloom: true },
	{ dpr: 0.72, volumetric: 0, iterations: 4, substeps: 2, bloom: true },
	{ dpr: 0.62, volumetric: 0, iterations: 3, substeps: 2, bloom: false }
];

const quality = {
	tier: 0,
	auto: true,
	dpr: 1,
	_window: [],
	_cooldown: 2.0
};

// Integrated Intel parts on this generation cannot carry the volumetric taps at
// full resolution; start them one tier down rather than making them earn it.
( function detect() {

	const gl = renderer.getContext();
	const ext = gl.getExtension( 'WEBGL_debug_renderer_info' );
	const name = ext ? String( gl.getParameter( ext.UNMASKED_RENDERER_WEBGL ) ) : '';

	if ( /Intel/i.test( name ) && ! /Arc/i.test( name ) ) quality.tier = 2;

	quality.gpu = name || 'unknown';

} )();

function applyTier() {

	const t = TIERS[ quality.tier ];
	quality.dpr = Math.min( t.dpr, devicePixelRatio );

	renderer.setPixelRatio( quality.dpr );
	rig.uniforms.uVolumetricSteps.value = t.volumetric;
	solver.iterations = t.iterations;
	// Fewer substeps is the last thing to give up: it trades tunnelling
	// resistance for frame time, and a fast object passing through a wall is a
	// worse failure than a soft one.
	solver.maxSubsteps = t.substeps;
	post.bloom.enabled = t.bloom;
	post.setSize( innerWidth, innerHeight, quality.dpr );

}

function governor( dt ) {

	if ( ! quality.auto ) return;

	quality._cooldown -= dt;
	quality._window.push( dt );
	if ( quality._window.length > 90 ) quality._window.shift();
	if ( quality._window.length < 90 || quality._cooldown > 0 ) return;

	const sorted = quality._window.slice().sort( ( a, b ) => a - b );
	// 90th percentile, not the mean — a stutter every ten frames is what makes
	// 6DOF feel bad, and an average hides it completely.
	const p90 = sorted[ Math.floor( sorted.length * 0.9 ) ];

	if ( p90 > 0.0215 && quality.tier < TIERS.length - 1 ) {

		quality.tier ++;
		applyTier();
		quality._cooldown = 3.0;
		quality._window.length = 0;

	} else if ( p90 < 0.0125 && quality.tier > 0 ) {

		quality.tier --;
		applyTier();
		quality._cooldown = 6.0;
		quality._window.length = 0;

	}

}

// --- tuning panel -----------------------------------------------------------
//
// Feel cannot be tuned without live sliders. This is the actual instrument of
// the experiment; the rest of the build is the apparatus around it.

const gui = new GUI( { title: 'APPARITION — feel test 01', width: 292 } );
gui.domElement.style.zIndex = 30;

const gFlight = gui.addFolder( 'Flight' );
gFlight.add( TUNING, 'thrustScale', 0.02, 0.6, 0.005 ).name( 'thrust' );
gFlight.add( TUNING, 'drag', 0.005, 0.12, 0.001 ).name( 'drag' );
gFlight.add( TUNING, 'recoilMass', 10, 300, 5 ).name( 'recoil mass (kg)' );
gFlight.add( TUNING, 'burnMultiplier', 1, 4, 0.05 ).name( 'burn x' );
gFlight.add( TUNING, 'mouseSensitivity', 0.01, 2, 0.01 ).name( 'mouse' );
gFlight.add( TUNING, 'rollThrustScale', 0.5, 5, 0.1 ).name( 'roll' );
gFlight.add( TUNING, 'keyRotScale', 0.1, 4, 0.05 ).name( 'arrow-key rotation' );
gFlight.add( TUNING, 'bankScale', 0, 0.2, 0.002 ).name( 'bank into turns' );
gFlight.add( TUNING, 'bankMaxDeg', 0, 40, 1 ).name( 'bank limit (deg)' );
gFlight.add( TUNING, 'wiggle', 0, 3, 0.05 ).name( 'wiggle' );
gFlight.add( TUNING, 'autoLevel' ).name( 'auto-level' );
gFlight.add( TUNING, 'autoLevelRate', 0, 3, 0.05 ).name( 'auto-level rate' );
gFlight.add( TUNING, 'invertY' ).name( 'invert Y' );

const gCam = gui.addFolder( 'Camera (embodiment)' );
gCam.add( TUNING, 'cameraLag', 0, 0.2, 0.002 ).name( 'position lag' );
gCam.add( TUNING, 'cameraLagPerKg', 0, 0.01, 0.0002 ).name( 'lag per kg' );
gCam.add( TUNING, 'rotationLag', 0, 0.2, 0.002 ).name( 'rotation lag' );
gCam.add( TUNING, 'swayAmount', 0, 3, 0.05 ).name( 'sway' );
gCam.add( camera, 'fov', 55, 110, 1 ).name( 'fov' ).onChange( () => camera.updateProjectionMatrix() );

const gAcc = gui.addFolder( 'Accretion (funnel)' );
gAcc.add( ACC, 'reach', 2, 20, 0.5 ).name( 'reach (m)' );
gAcc.add( ACC, 'mouthAngle', 0.1, 1.3, 0.01 ).name( 'mouth half-angle' );
gAcc.add( ACC, 'horizon', 0.3, 4, 0.05 ).name( 'event horizon (m)' );
gAcc.add( ACC, 'intake', 0, 80, 0.5 ).name( 'pull (m/s²)' );
gAcc.add( ACC, 'swirl', 0, 0.95, 0.01 ).name( 'swirl' );
// Turn this to zero and the funnel becomes a merry-go-round: swirl with no
// viscosity conserves angular momentum exactly and nothing ever falls in.
gAcc.add( ACC, 'viscosity', 0, 12, 0.1 ).name( 'viscosity (1/s)' );
// The one slider that is not about feel so much as tolerance: a funnel that
// tracks the camera exactly is a cursor, and a funnel that lags is a third
// motion vector on top of §47.6's two.
gAcc.add( ACC, 'axisLag', 0, 0.5, 0.005 ).name( 'axis lag (s)' );
gAcc.add( ACC, 'freeSpeed', 1, 30, 0.5 ).name( 'free speed (§10.2)' );
gAcc.add( ACC, 'capacity', 100, 4000, 25 ).name( 'capacity (kg)' );
gAcc.add( ACC, 'fireSpeed', 2, 40, 0.5 ).name( 'fire speed' );
gAcc.add( ACC, 'fireBudget', 100, 4000, 25 ).name( 'fire budget (N·s)' );
gAcc.add( ACC, 'fireMass', 5, 400, 5 ).name( 'kg per shot' );
gAcc.add( ACC, 'maxBurst', 1, 32, 1 ).name( 'max pieces / shot' );
gAcc.add( ACC, 'carryWattsPerKg', 0, 0.2, 0.002 ).name( 'W per kg carried' );
gAcc.add( ACC, 'intakeWattsPerKg', 0, 0.6, 0.005 ).name( 'W per kg·a' );
gAcc.add( accretion, 'selected', {
	tile: MATERIAL_KIND.TILE, concrete: MATERIAL_KIND.CONCRETE,
	glass: MATERIAL_KIND.GLASS, steel: MATERIAL_KIND.STEEL
} ).name( 'firing (wheel)' ).listen();

const gPhys = gui.addFolder( 'Solver (AVBD)' );
gPhys.add( solver, 'iterations', 1, 12, 1 ).name( 'iterations' );
gPhys.add( solver, 'beta', 1e3, 3e5, 1e3 ).name( 'beta (penalty ramp)' );
gPhys.add( solver, 'alpha', 0.5, 1, 0.01 ).name( 'alpha (stabilise)' );
gPhys.add( solver, 'gamma', 0.5, 1, 0.01 ).name( 'gamma (warmstart decay)' );
gPhys.add( solver, 'postStabilize' ).name( 'post-stabilise' );
gPhys.add( solver, 'sleepTime', 0.05, 3, 0.05 ).name( 'sleep after (s)' );
gPhys.add( solver, 'gravity', - 30, 0, 0.1 ).name( 'gravity' );
gPhys.add( solver, 'maxSubsteps', 1, 6, 1 ).name( 'max substeps' );
gPhys.add( solver, 'maxTravel', 0.03, 0.5, 0.01 ).name( 'travel / substep (m)' );

const gJoint = gui.addFolder( 'Bonds (weld joints)' );
gJoint.add( solver, 'creepRate', 0, 4, 0.05 ).name( 'creep rate' );
gJoint.add( { info: 'fracture reads lambda, in newtons' }, 'info' ).name( 'note' ).disable();
gJoint.add( {
	weaken() {

		// Halve every surviving weld in the level. Fast way to watch the delayed
		// shred (§45.5) without having to throw anything.
		for ( let j = 0; j < solver.jointCount; j ++ ) {

			if ( solver.jState[ j ] === 1 ) solver.jDamage[ j ] = Math.min( 0.95, solver.jDamage[ j ] + 0.5 );

		}

	}
}, 'weaken' ).name( 'halve all welds' );

const gWarp = gui.addFolder( 'Displacement (4th register)' );
gWarp.add( rig.uniforms.uWarpAmount, 'value', 0, 0.25, 0.002 ).name( 'ambient warp' );
gWarp.add( rig.uniforms.uWarpScale, 'value', 0.05, 3, 0.05 ).name( 'warp scale' );
gWarp.add( rig.uniforms.uShockThickness, 'value', 0.3, 6, 0.1 ).name( 'wave thickness' );
gWarp.add( {
	fire() { rig.shockwave( flight.position.x, flight.position.y, flight.position.z, 0.18, 12, 26 ); }
}, 'fire' ).name( 'shockwave from here' );

const gDust = gui.addFolder( 'Dust' );
gDust.add( dust.material.uniforms.uOpacity, 'value', 0, 1.5, 0.02 ).name( 'opacity' );
gDust.add( dust, 'densityDecay', 0, 1.5, 0.02 ).name( 'evidence decay' );

const gLook = gui.addFolder( 'Light & post' );
gLook.add( rig.uniforms.uFogDensity, 'value', 0, 0.16, 0.002 ).name( 'fog density' );
gLook.add( rig.uniforms.uFogHeightFalloff, 'value', 0, 0.5, 0.005 ).name( 'fog height' );
gLook.add( rig.uniforms.uVolumetricGain, 'value', 0, 2, 0.02 ).name( 'volumetric' );
gLook.add( rig.uniforms.uCausticStrength, 'value', 0, 4, 0.05 ).name( 'caustics' );
gLook.add( rig.uniforms.uCausticScale, 'value', 0.1, 2, 0.02 ).name( 'caustic scale' );
gLook.addColor( { c: '#0a141b' }, 'c' ).name( 'fog colour' )
	.onChange( v => rig.uniforms.uFogColor.value.set( v ) );
gLook.addColor( { c: '#0a1218' }, 'c' ).name( 'ambient' )
	.onChange( v => rig.uniforms.uAmbient.value.set( v ) );
gLook.add( POST, 'bloomStrength', 0, 2, 0.01 ).name( 'bloom' );
gLook.add( POST, 'bloomThreshold', 0, 1.5, 0.01 ).name( 'bloom threshold' )
	.onChange( v => post.bloom.threshold = v );
gLook.add( POST, 'bloomRadius', 0, 1.5, 0.01 ).name( 'bloom radius' )
	.onChange( v => post.bloom.radius = v );
gLook.add( POST, 'grain', 0, 0.2, 0.002 ).name( 'grain' );
gLook.add( POST, 'vignette', 0, 1.5, 0.01 ).name( 'vignette' );
gLook.add( POST, 'scanline', 0, 0.12, 0.002 ).name( 'scanline' );
gLook.add( POST, 'exposure', 0.2, 3, 0.02 ).name( 'exposure' );

const gPerf = gui.addFolder( 'Performance' );
gPerf.add( quality, 'auto' ).name( 'auto governor' );
gPerf.add( quality, 'tier', 0, TIERS.length - 1, 1 ).name( 'tier' ).listen().onChange( applyTier );
gPerf.add( audio, 'enabled' ).name( 'audio' );
gPerf.add( { gpu: quality.gpu }, 'gpu' ).name( 'gpu' ).disable();


// --- tuning export ----------------------------------------------------------
//
// Everything worth turning lives in a plain object somewhere, so a snapshot is
// just a walk over a declared list. The baseline is captured at boot and the
// export reports only what has moved, which is what makes it paste-ready: the
// output is the diff between the build and what you actually dialled, in a form
// that can go straight back into source.

const TUNE_GROUPS = [
	[ 'TUNING', TUNING, [ 'thrustScale', 'burnMultiplier', 'drag', 'recoilMass', 'wiggle',
		'mouseSensitivity', 'rollThrustScale', 'keyRotScale', 'invertY',
		'autoLevel', 'autoLevelRate',
		'cameraLag', 'cameraLagPerKg', 'cameraLagMax', 'rotationLag', 'swayAmount' ] ],
	[ 'ACC', ACC, [ 'reach', 'mouthAngle', 'horizon', 'intake', 'swirl', 'viscosity', 'axisLag',
		'freeSpeed', 'capacity', 'fireSpeed', 'fireBudget', 'fireMass', 'maxBurst',
		'carryWattsPerKg', 'intakeWattsPerKg' ] ],
	[ 'solver', solver, [ 'iterations', 'beta', 'alpha', 'gamma', 'postStabilize',
		'sleepTime', 'gravity', 'maxSubsteps', 'maxTravel', 'creepRate' ] ],
	[ 'POST', POST, [ 'bloomStrength', 'bloomThreshold', 'bloomRadius',
		'grain', 'vignette', 'scanline', 'exposure' ] ],
	[ 'dust', dust, [ 'densityDecay' ] ]
];

const TUNE_UNIFORMS = [ 'uFogDensity', 'uFogHeightFalloff', 'uVolumetricGain',
	'uCausticStrength', 'uCausticScale', 'uFogColor', 'uAmbient',
	'uWarpAmount', 'uWarpScale', 'uShockThickness' ];

function readTuning() {

	const out = [];

	for ( const [ label, obj, keys ] of TUNE_GROUPS ) {

		for ( const k of keys ) out.push( [ `${label}.${k}`, obj[ k ] ] );

	}

	for ( const u of TUNE_UNIFORMS ) {

		const v = rig.uniforms[ u ].value;
		out.push( [ `rig.uniforms.${u}.value`, v && v.isColor ? `#${v.getHexString()}` : v ] );

	}

	out.push( [ 'camera.fov', camera.fov ] );
	out.push( [ 'dust.material.uniforms.uOpacity.value', dust.material.uniforms.uOpacity.value ] );
	return out;

}

const TUNE_BASELINE = new Map( readTuning() );

function formatTuning() {

	const now = readTuning();
	const changed = now.filter( ( [ k, v ] ) => TUNE_BASELINE.get( k ) !== v );
	const rows = changed.length ? changed : now;
	const width = rows.reduce( ( w, [ k ] ) => Math.max( w, k.length ), 0 );

	const lines = rows.map( ( [ k, v ] ) => {

		// Colours are objects, so they are emitted as a call rather than an
		// assignment — `.value` stays on the path, it is not stripped.
		if ( typeof v === 'string' ) return `${k}.set( '${v}' );`;
		const val = typeof v === 'number' ? String( + v.toFixed( 5 ) ) : String( v );
		return `${k.padEnd( width )} = ${val};`;

	} );

	const header = changed.length
		? `// APPARITION tuning — ${changed.length} changed from build defaults`
		: '// APPARITION tuning — nothing changed from build defaults; full snapshot';

	return `${header}\n${lines.join( '\n' )}\n`;

}

const toast = document.getElementById( 'toast' );
let toastTimer = 0;

function showToast( text ) {

	toast.textContent = text;
	toast.classList.add( 'show' );
	clearTimeout( toastTimer );
	toastTimer = setTimeout( () => toast.classList.remove( 'show' ), 1600 );

}

function copyTuning() {

	const text = formatTuning();
	// Always log it too. The clipboard can be refused by the browser for reasons
	// that have nothing to do with this build, and losing a tuning pass to that
	// would be worse than the inconvenience of reading it out of the console.
	console.log( text );

	const done = () => showToast( `copied — ${text.split( '\n' ).length - 2} values` );

	const fallback = () => {

		const ta = document.createElement( 'textarea' );
		ta.value = text;
		ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
		document.body.appendChild( ta );
		ta.select();

		try { document.execCommand( 'copy' ); done(); }
		catch ( e ) { showToast( 'clipboard blocked — printed to console' ); }

		ta.remove();

	};

	if ( navigator.clipboard && isSecureContext ) {

		navigator.clipboard.writeText( text ).then( done, fallback );

	} else fallback();

}

gui.add( { copy: copyTuning }, 'copy' ).name( 'copy tuning to clipboard (P)' );

const actions = {
	respawnPanels() {

		// Persistence is real (§7.5) — this is a dev reset, not a game mechanic.
		for ( const p of panels ) destruction.restore( p );
		dust.clear();

	},
	activatePanels() {

		for ( const p of panels ) destruction.activate( p );

	},
	clearDebris() {

		accretion.vent();
		dust.clear();
		for ( let i = 0; i < solver.count; i ++ ) if ( solver.state[ i ] !== 0 ) solver.release( i );
		scatterProps( solver, ( i, kind ) => debris.register( i, kind ) );

	},
	resetFlight() { flight.reset(); },
	relight() { for ( const s of [ ...rig.strips, ...rig.practicals ] ) { s.dead = false; s.charge = 0; s.intensity = s.rated; } }
};

gui.add( actions, 'resetFlight' ).name( 'reset position (G)' );
gui.add( actions, 'respawnPanels' ).name( 'restore panels' );
gui.add( actions, 'activatePanels' ).name( 'activate panels' );
gui.add( actions, 'clearDebris' ).name( 'clear debris' );
gui.add( actions, 'relight' ).name( 'restore lighting' );

// Open, with the lighting folder expanded and the rest collapsed. Lighting is
// the thing you actually want to watch change while you drag it, and a panel you
// have to go find is a panel nobody opens.
gFlight.close();
gCam.close();
gPhys.close();
gJoint.close();
gWarp.close();
gDust.close();
gPerf.close();
gLook.open();
// The funnel is what this build exists to test, so it starts open next to the
// lighting rather than one click away.
gAcc.open();
let guiOpen = true;

addEventListener( 'keydown', e => {

	if ( e.code === 'Tab' ) {

		e.preventDefault();
		guiOpen = ! guiOpen;
		guiOpen ? gui.open() : gui.close();

	}

} );

// --- loop -------------------------------------------------------------------

let last = performance.now();
let elapsed = 0;
let accumulator = 0;
let dilation = 0;

const FIXED = 1 / 60;

// Dilation on alt+wheel — a continuous dial rather than a state (§45.7), and the
// cheapest possible test of §10.8's claim that large object counts are
// affordable *because* the fight is slow. Watch the contact count and frame time
// as you wind it in. The modifier is the §51.7 shortfall arriving on schedule:
// the bare wheel now selects which material fires, because that is the one the
// player touches every few seconds.
addEventListener( 'wheel', e => {

	if ( ! input.locked || ! e.altKey ) return;
	dilation = Math.max( 0, Math.min( 0.96, dilation - e.deltaY * 0.0006 ) );
	e.preventDefault();

}, { passive: false } );

applyTier();
post.setSize( innerWidth, innerHeight, quality.dpr );

function frame() {

	requestAnimationFrame( frame );

	const now = performance.now();
	let dt = ( now - last ) / 1000;
	last = now;

	// A backgrounded tab returns with a huge dt; clamping is the difference
	// between resuming and exploding.
	if ( dt > 0.1 ) dt = 0.1;
	elapsed += dt;

	governor( dt );

	const state = input.sample();
	state.probe = input.pressed( 'probe' );
	state.vent = input.pressed( 'vent' );
	if ( input.pressed( 'reset' ) ) flight.reset();
	if ( input.pressed( 'copyTuning' ) ) copyTuning();

	if ( input.locked ) {

		flight.update( state, dt );

	} else {

		state.mouseX = 0;
		state.mouseY = 0;

	}

	// Physics runs on a fixed step regardless of frame rate. AVBD is
	// unconditionally stable so a variable step would not blow up, but contact
	// warm-starting and the friction anchors both assume a consistent dt.
	const scaled = dt * ( 1 - dilation );
	accumulator += scaled;
	let steps = 0;

	while ( accumulator >= FIXED && steps < 3 ) {

		solver.step( FIXED );
		accumulator -= FIXED;
		steps ++;

	}

	if ( accumulator > FIXED * 3 ) accumulator = 0;

	accretion.update( state, Math.max( dt, 1e-4 ), destruction );
	destruction.update( dt, flight );
	debris.update( dt );
	dust.update( dt, flight.viewPosition, flight.velocity );

	rig.uniforms.uTime.value = elapsed;
	rig.update( dt, flight.viewPosition );

	audio.setLoad( Math.min( 1, accretion.watts / ACC.wattScale ) );
	flight.lastImpact *= 0.6;

	camera.position.copy( flight.viewPosition );
	camera.quaternion.copy( flight.viewQuaternion );

	post.update( dt, elapsed, { watts: accretion.watts, heat: accretion.heat, dilation } );
	post.render( dt );

	hud.update( dt, {
		tier: quality.tier,
		dpr: quality.dpr,
		active: solver.stats.active,
		asleep: solver.stats.asleep,
		contacts: solver.stats.contacts,
		substeps: solver.stats.substeps,
		watts: accretion.watts,
		wattScale: ACC.wattScale,
		panels: panels.map( p => ( {
			state: PANEL_STATE_NAME[ p.state ],
			active: p.activated,
			open: p.openCount | 0,
			cells: p.chunks.length,
			joints: p.activated ? destruction.liveJoints( p ) : 0,
			totalJoints: p.joints.length,
			loose: p.activated ? destruction.detachedCount( p ) : 0
		} ) ),
		dust: dust.live,
		suspended: dust.suspended,
		pool: accretion.pool,
		poolMass: accretion.mass,
		capacity: ACC.capacity,
		selected: accretion.selected,
		materialNames: MATERIAL_NAME,
		inFunnel: accretion.inFunnel,
		consumed: accretion.consumed,
		stalled: accretion.stalled,
		speed: flight.velocity.length(),
		light: rig.remaining(),
		dilation,
		probe: accretion.probeInfo
	} );

}

addEventListener( 'resize', () => {

	camera.aspect = innerWidth / innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( innerWidth, innerHeight );
	post.setSize( innerWidth, innerHeight, quality.dpr );

} );

frame();

// Exposed for console poking during tuning.
window.APPARITION = { solver, rig, flight, accretion, destruction, debris, dust, panels, quality, post,
	TUNING, ACC, POST, copyTuning, readTuning, formatTuning };
