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
import { ShredField, SHRED } from './shred.js';
import { ScanField, SCAN } from './scan.js';
import { PostStack, POST } from './fx.js';
import { HYDRA } from './hydra.js';
import { ModMatrix, CURVES } from './modulation.js';
import { MetaSurface, SurfaceMarkers } from './metasurface.js';
import { PARAMS, BY_PATH, FOLDERS, paramsIn, warnLevel } from './params.js';
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
// Headroom for the glass case, which is the densest stream by an order of
// magnitude — eleven hundred needles a second against eighty-four steel grains.
const shred = new ShredField( scene, rig, 3200 );
const accretion = new Accretion( solver, flight, debris, shred );
const destruction = new Destruction( scene, rig, solver, debris );
const panels = addTestPanels( destruction, rig, ROOM );
flight.panels = panels;

const dust = new DustField( scene, rig, {
	min: { x: - ROOM.halfW, y: ROOM.pool.bottom, z: - ROOM.halfD },
	max: { x: ROOM.halfW, y: ROOM.height, z: ROOM.halfD }
}, 900 );

scatterProps( solver, ( i, kind ) => debris.register( i, kind ) );

// The scan. Built from the solver's own colliders — scan.js says why that is not
// optional — and off by default, because the whole point of building it as an
// overlay is being able to A/B it against the meshes in the same room rather than
// arguing about it.
const scan = new ScanField( scene, rig, ROOM );
scan.build( solver, panels );

// The scan is the world now, and 'mesh' survives only as a reference view for
// checking that the two agree.
const VIEW = { mode: 'scan' };

function applyView() {

	const showMesh = VIEW.mode !== 'scan';
	scan.points.visible = VIEW.mode !== 'mesh';

	// Everything in the room group goes except the emitters. A light fixture is
	// not architecture being sensed, it is the source doing the sensing — it has
	// to stay solid or the room loses the only thing it is lit by.
	for ( const c of room.group.children ) c.visible = c === room.emitters ? true : showMesh;
	for ( const p of panels ) if ( p.mesh ) p.mesh.visible = showMesh;

	// Loose matter keeps its solid geometry in every mode, and that is a position
	// rather than a compromise. Architecture is inferred; a chunk you tore out of
	// it is a real object you are carrying. Solidity marks what you can touch,
	// which is most of what stops a point-cloud world being unreadable.

	flight.scanActive = VIEW.mode !== 'mesh';

}

flight.scan = scan;
applyView();

// --- the patch bay ----------------------------------------------------------
//
// Everything the look is made of is a destination; everything the game knows
// about itself is a source. Routes are data rather than branches in the render
// loop, which is why the same mechanism drives the feedback chain, the scan, the
// post grade and the flight model.
//
// The routes below are a starting patch and nothing more. Every one of them is
// on the panel with its own on switch, amount, curve, a live number saying what
// it is writing this instant, and an unpatch button; new ones are made from any
// registered source to any parameter in the table without touching source. What
// this file provides is a default, not a fixture.
//
// That distinction is the whole repair. The previous version had the same
// twenty-six routes and no way to see or remove any of them, and two of them
// summed HYDRA.feedback from 0.70 to 1.11 — above one, a screen-blend loop
// multiplies every pass and the room is gone in about two seconds. Three numbers
// adding to 1.11 look exactly like one number that is 1.11, so the sum was
// unfindable, and the routes were mine rather than chosen, so the obvious first
// move was not available either.
//
// The division of labour: sources live in code because each one reads something
// out of the world, which is the part that genuinely needs code. Destinations
// come from the parameter table. Everything else is runtime. Adding a source or
// a parameter never means editing the panel, the routable set or the readout,
// because none of the three keeps a list of its own any more.

const mod = new ModMatrix( { HYDRA, SCAN, POST, ACC, SHRED, TUNING } );

mod
	.addSource( 'speed', st => st.speed / 30, { attack: 0.25, release: 0.9 } )
	.addSource( 'burn', st => st.burn ? 1 : 0, { attack: 0.05, release: 0.35 } )
	// How full the disc is. The one the player watches, so it should be the one
	// the world reacts to most visibly.
	.addSource( 'disc', st => st.saturation, { attack: 0.6, release: 1.4 } )
	.addSource( 'draw', st => st.watts / ACC.wattScale, { attack: 0.12, release: 0.7 } )
	.addSource( 'heat', st => st.heat / ACC.heatCeiling, { attack: 0.5, release: 2.5 } )
	.addSource( 'intake', st => st.intake ? 1 : 0, { attack: 0.18, release: 0.6 } )
	.addSource( 'channel', st => st.channelling ? 1 : 0, { attack: 0.06, release: 0.4 } )
	// Transients. Short attack, long release — a hit is two frames and a raw
	// route on it is a click, where a swell and a decay is an event.
	.addSource( 'impact', st => Math.min( 1, st.impact / 9 ), { attack: 0.01, release: 1.6 } )
	.addSource( 'eaten', st => st.eatenPulse, { attack: 0.01, release: 1.1 } )
	// How much of the room near you has stopped existing. Standing in your own
	// damage should not look like standing anywhere else.
	.addSource( 'ruin', st => 1 - st.intactNear, { attack: 0.4, release: 2.0 } )
	.addSource( 'dark', st => 1 - st.light, { attack: 0.8, release: 2.0 } )
	.addSource( 'dilation', st => st.dilation, { attack: 0.15, release: 0.5 } )
	.addSource( 'height', st => Math.max( 0, Math.min( 1, st.y / ROOM.height ) ), { attack: 0.5, release: 0.5 } )
	// Placeholder until §38 exists. Nearest live body standing in for a threat,
	// so the routing is real and only the definition of "enemy" is pending.
	.addSource( 'proximity', st => st.proximity, { attack: 0.2, release: 1.0 } );

// A starting patch, written as data rather than as a call chain — `route()`
// hands back the route so the editor can hold on to it, so a chain would not
// read anyway, and a table is the honest shape for something that is meant to be
// edited from outside.
//
// Every entry gets its own folder in the panel: an on switch, an amount, a
// curve, a live number saying what it is writing this instant, and an unpatch
// button. Nothing here is load-bearing, and nothing here is privileged over a
// route patched by hand a minute ago.
//
// Two amounts are detuned from what they were. HYDRA.feedback rests at 0.70, and
// speed at 0.16 plus dilation at 0.25 put it at 1.11 with both up — above one a
// screen-blend loop multiplies every pass and the room is gone in about two
// seconds. The routes were right; the arithmetic was just never anywhere it
// could be seen. It is now, and these two are set so the default stays
// contractive at full deflection instead of depending on nobody dilating at
// speed. Both are sliders: going past one on purpose is a legitimate thing to
// want, and the readout says when you have.

const STARTING_PATCH = [

	// The faster you go, the more the loop drags — this is the one that makes
	// speed feel like something rather than a number.
	[ 'speed', 'HYDRA.feedback', 0.10, 'square' ],
	[ 'speed', 'HYDRA.zoom', 0.004, 'square' ],
	[ 'burn', 'HYDRA.modAmount', 0.010 ],

	// Carrying mass folds the frame. The disc is the resource you watch, so it
	// gets the biggest visual lever in the file. At seven sides a full disc folds
	// the brightest region of the room across the whole frame and the world
	// disappears into a mandala; four reads as pressure rather than as a takeover.
	[ 'disc', 'HYDRA.kaleid', 4, 'square' ],
	[ 'disc', 'HYDRA.colorama', 0.02 ],
	[ 'disc', 'HYDRA.saturate', 0.25 ],

	[ 'draw', 'HYDRA.selfModulate', 0.9, 'square' ],
	[ 'draw', 'POST.bloomStrength', 0.35 ],
	[ 'heat', 'HYDRA.shiftR', 0.035 ],
	[ 'heat', 'HYDRA.chromaSplit', 0.004 ],

	// Opening the funnel pulls the whole field into it.
	[ 'intake', 'HYDRA.rotate', 0.055 ],
	[ 'intake', 'HYDRA.modRotateAmount', 0.09 ],
	[ 'channel', 'HYDRA.modScaleAmount', 0.02 ],
	[ 'channel', 'HYDRA.live', 0.30 ],

	// Getting hit throws the loop and it takes a beat to settle.
	[ 'impact', 'HYDRA.modAmount', 0.030, 'root' ],
	[ 'impact', 'HYDRA.invert', 0.35, 'square' ],
	[ 'eaten', 'HYDRA.worldDisplace', 0.9, 'root' ],

	// Wrecked ground reads as failing resolution rather than as damage decals —
	// §48's register, driven by the thing that should have been driving it.
	[ 'ruin', 'HYDRA.pixelate', 90, 'square' ],
	[ 'ruin', 'HYDRA.posterize', 6, 'gate' ],
	[ 'dark', 'HYDRA.thresh', 0.16 ],
	[ 'dark', 'SCAN.glow', 0.5 ],

	[ 'dilation', 'HYDRA.feedback', 0.14 ],
	[ 'dilation', 'HYDRA.modSpeed', - 0.12 ],
	[ 'height', 'HYDRA.colorama', 0.02, 'band' ],
	[ 'proximity', 'HYDRA.repeatX', 2.5, 'square' ],
	[ 'proximity', 'HYDRA.repeatY', 2.5, 'square' ]

];

for ( const [ from, to, amount, curve ] of STARTING_PATCH ) mod.route( from, to, amount, curve );

// --- metasurfaces -----------------------------------------------------------
//
// Bencina's two-to-many mapping: parameter snapshots placed on the plan of the
// level, natural-neighbour interpolation between them, and placement doing the
// authoring. One surface per parameter folder, so each owns a disjoint set —
// two surfaces writing one parameter is the thing that makes a layered system
// impossible to reason about, and splitting by folder makes that structural
// rather than something to remember.
//
// Deriving the key sets from the table rather than listing them means a
// parameter added to params.js is placeable without touching this file. Every
// surface starts empty, and an empty surface does nothing whatsoever — what
// belongs where is a question for somebody who can see it.

const surfaces = FOLDERS.map( name => new MetaSurface(
	name.toLowerCase(), paramsIn( name ).map( q => q.path ), { vertical: 7 } ) );

for ( const ms of surfaces ) mod.surface( ms );

const markers = new SurfaceMarkers( scene );

// The editor gesture, and it is one gesture: dial the look on the panel, fly to
// where it belongs, take it. Capture reads the *base* — what the sliders say —
// so a preset describes a place rather than whatever cue happened to be up as
// you flew through.
const editor = {

	surface: surfaces[ 0 ].name,
	label: '',

	capture() {

		const ms = surfaces.find( s => s.name === editor.surface );
		if ( ! ms ) return;
		const p = flight.viewPosition;
		const preset = ms.capture( editor.label || '', p.x, p.y, p.z, k => mod.base( k ) );
		editor.label = '';
		rebuildPresetGui();
		showToast( `captured "${preset.label}" on ${ms.name}\n${
			ms.presets.length} preset${ms.presets.length === 1 ? '' : 's'} on this surface` );

	},

	bake() {

		const src = surfaces.map( s => s.bake() ).join( '\n' );
		navigator.clipboard && navigator.clipboard.writeText( src ).catch( () => {} );
		console.log( src );
		showToast( `baked ${surfaces.reduce( ( n, s ) => n + s.presets.length, 0 )} presets to the clipboard` );

	},

	clearSurface() {

		const ms = surfaces.find( s => s.name === editor.surface );
		if ( ms ) { ms.presets.length = 0; rebuildPresetGui(); }

	},

	showMarkers: false

};

// The panel and the patch bay write the same numbers, so a drag has to become
// the new ground rather than being stamped over by the old one.
const modState = { x: 0, y: 0, z: 0, speed: 0, burn: false, saturation: 0, watts: 0,
	heat: 0, intake: false, channelling: false, impact: 0, eatenPulse: 0,
	intactNear: 1, light: 1, dilation: 0, proximity: 0 };

const post = new PostStack( renderer, scene, camera );
const audio = new ImpactAudio();
const hud = new Hud( document.getElementById( 'hud' ), document.getElementById( 'reticle' ) );
const input = new Input( renderer.domElement, document.getElementById( 'gate' ) );

document.getElementById( 'gate' ).addEventListener( 'click', () => audio.resume(), { once: true } );

// --- reactions --------------------------------------------------------------

const _camDir = new THREE.Vector3();
const _prevViewProj = new THREE.Matrix4();
let eatenPulse = 0;

solver.onImpact = ( i, speed, x, y, z, material ) => {

	// Pan by which side of the view the hit landed on. Cheap, and with no visible
	// protagonist it is most of the spatial information the player gets.
	_camDir.set( 1, 0, 0 ).applyQuaternion( flight.viewQuaternion );
	const pan = Math.max( - 1, Math.min( 1,
		( ( x - flight.viewPosition.x ) * _camDir.x +
		  ( y - flight.viewPosition.y ) * _camDir.y +
		  ( z - flight.viewPosition.z ) * _camDir.z ) * 0.2 ) );

	audio.impact( speed, material, pan );

	if ( VIEW.mode !== 'mesh' && speed > 3 ) {

		scan.carve( x, y, z, 0.22 + Math.min( 1.0, speed * 0.045 ), Math.min( 0.9, speed * 0.035 ) );

	}

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

	// A weld letting go erodes the cloud where it let go, so the panel's own
	// chunk physics and the scan cannot tell different stories about the wall.
	if ( VIEW.mode !== 'mesh' ) scan.carve( x, y, z, 0.34 + Math.min( 0.9, force / 9000 ), 0.75 );

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

// Consumption is silent geometry unless it is heard. A material-coloured hit per
// body eaten tells a bench from a shard without a readout, and anything with
// real mass in it also has to land in the room — the fourth register (§48.3),
// shape only, no colour. Without this the funnel swallowed a 430kg bench with
// the same weight of feedback as a floor tile, which is most of why it read as
// limp no matter how hard it pulled.
accretion.onConsume = ( kind, mass, x, y, z ) => {

	audio.impact( 1.4 + Math.min( 6, mass * 0.055 ), kind, 0 );
	eatenPulse = Math.min( 1, eatenPulse + Math.min( 1, mass * 0.008 ) );
	// Lighter than it was: the shard burst now carries the visual, and stacking a
	// dust plume on top of it just fogs the thing you want to watch come apart.
	dust.puff( x, y, z, 200 + mass * 3, 0, 1, 0 );

	// Eating something against a surface takes a bite out of the surface too.
	if ( VIEW.mode !== 'mesh' ) scan.carve( x, y, z, 0.5 + Math.min( 2.2, mass * 0.004 ), Math.min( 1, mass * 0.006 ) );

	if ( mass > 55 ) {

		rig.shockwave( x, y, z, Math.min( 0.13, 0.03 + mass * 0.00018 ), 9, 17 );
		for ( const s of rig.strips ) rig.pulse( s, Math.min( 0.34, mass * 0.0006 ) );

	}

};

// The jet is a rate, so the sound has to be a rate too — a discrete clip per
// frame would machine-gun. This ticks only when the stream starts or stops.
let jetOn = false;
accretion.onFire = ( kind, count, drawn ) => {

	if ( ! jetOn ) { audio.release( 5 ); jetOn = true; }

};
accretion.onVent = dumped => audio.release( 4 + Math.min( 8, dumped * 0.01 ) );

// A shard landing on something. Thousands of these a second would be thousands
// of sounds and thousands of dust puffs, so both are rationed by a frame budget
// — the strike itself always counts, only the feedback is sampled.
let strikeBudget = 0;

// Every static thing a shard can land on. Assembled once — the room does not
// gain colliders at runtime, and rebuilding this per frame would be the only
// allocation in the shard path.
const shredWorld = { planes: solver.planes, boxes: solver.boxes, panels };

shred.onStrike = ( x, y, z, nx, ny, nz, joules, material, panel ) => {

	if ( panel || destruction.hasActive ) destruction.strike( x, y, z, - nx, - ny, - nz, joules );

	// Erosion. One call, no chunk grid, no weld lattice, no state machine — this
	// is the entire destruction model for a scanned surface, and unlike destruct.js
	// it works on every surface in the room rather than on the three that were
	// authored for it.
	if ( VIEW.mode !== 'mesh' ) {

		scan.carve( x, y, z, 0.10 + Math.min( 0.5, joules * 0.0016 ), Math.min( 0.7, joules * 0.004 ) );

	}

	if ( strikeBudget > 0 && joules > 6 ) {

		strikeBudget --;
		audio.impact( 0.9 + Math.min( 3, joules * 0.02 ), material, 0 );
		if ( joules > 30 ) dust.puff( x, y, z, 90 + joules * 4, nx, ny, nz );

	}

};

// --- quality governor -------------------------------------------------------
//
// A 2019 MacBook is anything from an Iris Plus 645 to a Radeon Pro 5500M, a
// range of roughly 6x. Rather than target the floor and look cheap on the
// ceiling, start optimistic and step down on sustained frame time. Steps are
// ordered cheapest-look-cost first: volumetric taps, then resolution, then
// solver iterations, then bloom.

// `scan` is the fraction of the point set drawn. It is first in the step-down
// order for the same reason volumetric taps were: thinning a cloud evenly costs
// almost nothing to look at, where dropping resolution costs a lot.
const TIERS = [
	{ dpr: 1.00, volumetric: 3, iterations: 6, substeps: 3, bloom: true, scan: 1.00 },
	{ dpr: 1.00, volumetric: 2, iterations: 5, substeps: 3, bloom: true, scan: 0.74 },
	{ dpr: 0.85, volumetric: 1, iterations: 4, substeps: 3, bloom: true, scan: 0.56 },
	{ dpr: 0.72, volumetric: 0, iterations: 4, substeps: 2, bloom: true, scan: 0.42 },
	{ dpr: 0.62, volumetric: 0, iterations: 3, substeps: 2, bloom: false, scan: 0.30 }
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
	scan.setLod( t.scan );
	scan.uniforms.uPixelRatio.value = quality.dpr;

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

// --- the panel --------------------------------------------------------------
//
// Generated from params.js. The ranges used to be literals inside the gui.add()
// calls, which meant the panel, the routable set and the modulation system each
// held a private idea of what a parameter was; adding one meant editing three
// places and remembering a fourth thing — the value past which it misbehaves —
// that was written down nowhere at all. One table now, read by all three. A
// parameter added there appears here, becomes routable, becomes placeable on a
// metasurface and shows up in the readout, without this file learning anything
// about it.

const gParam = {};

for ( const name of FOLDERS ) {

	const f = gui.addFolder( name );
	gParam[ name ] = f;

	for ( const q of paramsIn( name ) ) {

		const t = mod.resolve( q.path );
		if ( ! t ) continue;

		// A hand-drag has to become the new ground. Modulation is an offset from
		// the panel, so without this the base captured before the drag keeps being
		// restored underneath and the slider appears to spring back. The dragged
		// value is passed rather than re-read, so a route that is up at the time
		// does not get folded into it.
		f.add( t.obj, t.key, q.min, q.max, q.step ).name( q.label )
			.onChange( v => mod.setBase( q.path, v ) );

	}

}

// The things that are not a number with a range, hung on the folder they belong
// to rather than given one of their own.

gParam.Hydra.add( HYDRA, 'enabled' ).name( 'loop on' )
	.onChange( v => { if ( ! v ) post.hydraChain.clear(); } );

gParam.Scan.add( VIEW, 'mode', [ 'mesh', 'scan', 'both' ] ).name( 'world' ).onChange( applyView );
// Deliberately not in the table. The quality governor steps this down under
// load, and a route and an automatic governor fighting over one number is a bug
// with no owner.
gParam.Scan.add( SCAN, 'lod', 0.05, 1, 0.01 ).name( 'density (LOD)' ).listen()
	.onChange( v => scan.setLod( v ) );

gParam.Accretion.add( accretion, 'selected', {
	tile: MATERIAL_KIND.TILE, concrete: MATERIAL_KIND.CONCRETE,
	glass: MATERIAL_KIND.GLASS, steel: MATERIAL_KIND.STEEL
} ).name( 'firing (wheel)' ).listen();

gParam.Flight.add( TUNING, 'autoLevel' ).name( 'auto-level' );
gParam.Flight.add( TUNING, 'invertY' ).name( 'invert Y' );
gParam.Flight.add( camera, 'fov', 55, 110, 1 ).name( 'fov' )
	.onChange( () => camera.updateProjectionMatrix() );

// --- the readout ------------------------------------------------------------
//
// The instrument, and the whole answer to "something in here creates runaway
// feedback and I cannot find it". A sum you can only see the result of is a sum
// you cannot debug: three numbers adding to 1.11 look exactly like one number
// that is 1.11. So every destination anything writes prints its base, every
// contribution by name, and the total that actually landed.
//
// Nothing here prevents anything. Reaching a runaway on purpose is a legitimate
// thing to want — hydra's own sketches live on that edge — so the readout says
// where the edge is and then gets out of the way.

const patchEl = document.getElementById( 'patch' );
// `all` prints every destination anything could write; off, it prints only the
// ones being moved right now plus anything past a known threshold. Ninety-five
// parameters is four screens of mostly "base, and nothing happened", and a
// readout you have to scroll past to find the live row is one you stop opening.
const readout = { show: false, all: false, rate: 8, lines: 40 };
let readoutClock = 0;

// The budget is in lines, not entries: an entry is anything from three lines to
// nine depending on how many routes land on it, so a cap counted in entries
// either wastes two thirds of the panel or runs off the bottom of the screen.
// The element clips rather than scrolls — it has pointer-events: none, so a
// scrollbar on it would be decorative.
//
// Measured against the debug readout above it rather than against the viewport,
// because that one grows and shrinks: a panel goes from intact to breached, the
// funnel starts channelling, the pause line appears. A fixed fraction of the
// screen is right until one of those happens and then the two overlap.
const LINE_PX = 16.5;

function fitReadout() {

	const above = hud.el.getBoundingClientRect().bottom;
	readout.lines = Math.max( 10, Math.floor( ( innerHeight - above - 28 ) / LINE_PX ) );

}

const pad = ( s, n ) => s + ' '.repeat( Math.max( 0, n - s.length ) );

function fmt( v ) {

	const a = Math.abs( v );
	return a >= 100 ? v.toFixed( 0 ) : a >= 1 ? v.toFixed( 3 ) : v.toFixed( 4 );

}

function drawReadout() {

	fitReadout();
	const rows = [];

	// The loop-stability line first, because it is the one that eats the room. A
	// screen-blend feedback chain is contractive only while what survives a pass
	// times the gain applied to it stays under one. Above that every pass
	// multiplies, and at the numbers this build ships with that is about two
	// seconds from a lit room to a white one.
	const loop = HYDRA.feedback * HYDRA.gain;
	rows.push( loop >= 1
		? `<span class="warn">feedback x gain  ${fmt( loop )}   LOOP GROWS EVERY PASS</span>`
		: `feedback x gain  <b>${fmt( loop )}</b>   <u>contracting</u>` );
	rows.push( '' );

	// Which sources are awake, on one line. Half of reading a breakdown is knowing
	// whether the thing feeding it is even up.
	const live = mod.active( 0.02 );
	rows.push( live.length
		? `sources          ${live.slice( 0, 7 ).map( s => `<i>${s.name}</i> ${( s.value * 100 ).toFixed( 0 )}` ).join( '  ' )}`
		: '<u>sources          all at rest</u>' );
	rows.push( '' );

	// Sorted by how far each destination has been pushed off its base, so the
	// thing doing the most is at the top rather than wherever the alphabet put it.
	const entries = mod.written().map( path => mod.explain( path ) );
	entries.forEach( e => {

		e._warn = warnLevel( e.path );
		e._hot = e._warn !== null && e.total > e._warn;
		e._moved = Math.abs( e.total - e.base ) > 1e-9 || !! e.surface;

	} );

	entries.sort( ( a, b ) => ( b._hot - a._hot ) ||
		( Math.abs( b.total - b.base ) - Math.abs( a.total - a.base ) ) ||
		a.path.localeCompare( b.path ) );

	const shown = readout.all ? entries : entries.filter( e => e._moved || e._hot );
	const quiet = entries.length - shown.length;

	if ( ! entries.length ) rows.push( '<u>nothing routed — the sliders are the only thing writing</u>' );
	else if ( ! shown.length ) rows.push( `<u>${entries.length} destinations patched, none moving</u>` );

	let printed = 0;

	for ( const e of shown ) {

		const block = [ `<b>${e.path}</b>`, `  ${pad( 'base', 20 )} ${fmt( e.base )}` ];

		// A surface is absolute rather than additive, so it does not appear as a
		// term — it replaces the base before anything is added to it. Naming it is
		// the difference between "this is not what the slider says" and "this is
		// not what the slider says, and here is what owns it".
		if ( e.surface ) block.push( `  ${pad( `surface ${e.surface}`, 20 )} <i>absolute, replaces base</i>` );

		for ( const c of e.contributions ) {

			const tag = c.curve === 'linear' ? c.from : `${c.from} ${c.curve}`;
			block.push( `  <i>${pad( tag, 20 )}</i> ${c.value >= 0 ? '+' : '-'} ${fmt( Math.abs( c.value ) )}` );

		}

		block.push( e._hot
			? `  <span class="warn">${pad( '=', 20 )} ${fmt( e.total )}   past ${e._warn}</span>`
			: `  ${pad( '=', 20 )} <b>${fmt( e.total )}</b>` );
		block.push( '' );

		// Two lines held back for the tallies, so the thing that tells you it was
		// truncated is never itself the thing that gets truncated.
		if ( rows.length + block.length > readout.lines - 2 ) break;

		rows.push( ...block );
		printed ++;

	}

	// Never silently truncate. A readout showing nine of thirty and saying nothing
	// reads exactly like a readout showing everything.
	if ( printed < shown.length ) rows.push( `<u>+ ${shown.length - printed} more moving, off the bottom</u>` );
	if ( quiet > 0 ) rows.push( `<u>+ ${quiet} patched and resting  —  "all" in the panel shows them</u>` );

	patchEl.innerHTML = rows.join( '\n' );

}

// --- the patch bay ----------------------------------------------------------

const gMod = gui.addFolder( 'Patch bay' );
gMod.add( mod, 'enabled' ).name( 'modulation on' );
// Sliders rebase themselves as they are dragged. This is for values set from
// somewhere else — the console, a pasted tuning export — and it backs the live
// routes out of the numbers before adopting them, so calling it twice does the
// same thing as calling it once.
gMod.add( { rebase() { mod.rebase(); } }, 'rebase' ).name( 'adopt live values as base' );
gMod.add( readout, 'show' ).name( 'readout (M)' ).listen()
	.onChange( v => patchEl.classList.toggle( 'show', v ) );
gMod.add( readout, 'all' ).name( 'readout: all, not just moving' );
gMod.add( readout, 'rate', 1, 30, 1 ).name( 'readout refresh (Hz)' );

// Sources. The one part that has to live in code, because each of them reads
// something out of the world — but their shaping does not, so the two time
// constants and the scale are on the panel with everything else. A hit is two
// frames long and a raw route off it clicks; the release is what makes it an
// event.
const gSources = gMod.addFolder( 'sources' );

for ( const s of mod.sources.values() ) {

	const f = gSources.addFolder( s.name );
	f.add( s, 'value', 0, 1 ).name( 'now' ).listen().disable();
	f.add( s, 'attack', 0, 3, 0.01 ).name( 'attack (s)' );
	f.add( s, 'release', 0, 8, 0.05 ).name( 'release (s)' );
	f.add( s, 'scale', 0.05, 8, 0.05 ).name( 'scale' );
	f.close();

}

gSources.close();

// Routes. Any registered source, to any parameter in the table, with an amount
// in the destination's own units and a curve between them. Made here rather
// than in source, because whoever makes one has to be able to see what it does.
const gRoutes = gMod.addFolder( 'routes' );

const SOURCE_NAMES = [ ...mod.sources.keys() ];
const DEST_PATHS = PARAMS.map( q => q.path );

const patch = {
	from: SOURCE_NAMES[ 0 ],
	to: DEST_PATHS[ 0 ],
	amount: 0,
	curve: 'linear',
	patch() { addRouteGui( mod.route( patch.from, patch.to, patch.amount, patch.curve ) ); },
	unpatchAll() { while ( mod.routes.length ) mod.unroute( mod.routes[ 0 ] ); rebuildRouteGui(); }
};

const gNew = gRoutes.addFolder( 'patch a new one' );
gNew.add( patch, 'from', SOURCE_NAMES ).name( 'source' );
gNew.add( patch, 'to', DEST_PATHS ).name( 'destination' ).onChange( fitAmount );
const cAmount = gNew.add( patch, 'amount', - 1, 1, 0.01 ).name( 'amount at full' );
gNew.add( patch, 'curve', Object.keys( CURVES ) ).name( 'curve' );
gNew.add( patch, 'patch' ).name( 'PATCH IT' );

// The amount is in the destination's own units, so the slider has to take the
// destination's own span. A range of +/-1 means nothing against kaleid, which
// counts sides, and is the entire useful range and then some against
// chromaSplit, which lives near a thousandth.
function fitAmount() {

	const q = BY_PATH.get( patch.to );
	if ( ! q ) return;
	const span = q.max - q.min;
	patch.amount = Math.max( - span, Math.min( span, patch.amount ) );
	cAmount.min( - span ).max( span ).step( q.step ).updateDisplay();

}

fitAmount();

// One folder per live route. `writing now` is the important row: a route whose
// contribution you can watch move is a route you can rule in or out in a second
// rather than by deleting it and reloading.
const _routeFolders = [];

function addRouteGui( r ) {

	const q = BY_PATH.get( r.to );
	const span = q ? q.max - q.min : Math.abs( r.amount ) * 4 + 1e-3;

	const f = gRoutes.addFolder( `${r.from} -> ${r.to}` );
	f.add( r, 'on' ).name( 'on' );
	f.add( r, 'amount', - span, span, q ? q.step : span / 200 ).name( 'amount at full' );
	f.add( r, 'curve', Object.keys( CURVES ) ).name( 'curve' );
	f.add( r, 'contribution' ).name( 'writing now' ).listen().disable();
	f.add( { unpatch() { mod.unroute( r ); f.destroy(); } }, 'unpatch' ).name( 'unpatch' );
	f.close();
	_routeFolders.push( f );
	return r;

}

function rebuildRouteGui() {

	for ( const f of _routeFolders ) f.destroy();
	_routeFolders.length = 0;
	for ( const r of mod.routes ) addRouteGui( r );

}

gRoutes.add( patch, 'unpatchAll' ).name( 'unpatch everything' );

// The starting patch, given the same folder treatment as anything patched by
// hand. There is nothing privileged about a route that came from source.
rebuildRouteGui();

// --- metasurfaces on the panel ----------------------------------------------

const gSurf = gMod.addFolder( 'metasurfaces' );
gSurf.add( editor, 'surface', surfaces.map( s => s.name ) ).name( 'editing' );
gSurf.add( editor, 'label' ).name( 'label' ).listen();
gSurf.add( editor, 'capture' ).name( 'CAPTURE HERE  (K)' );
gSurf.add( editor, 'bake' ).name( 'bake to clipboard' );
gSurf.add( editor, 'clearSurface' ).name( 'clear this surface' );
gSurf.add( editor, 'showMarkers' ).name( 'show markers' )
	.onChange( v => { markers.points.visible = v; } );

for ( const ms of surfaces ) {

	const f = gSurf.addFolder( ms.name );
	f.add( ms, 'enabled' ).name( 'on' );
	// Zero hands the parameters back to the sliders, which is how a surface gets
	// auditioned against the look it is meant to replace.
	f.add( ms, 'blend', 0, 1, 0.02 ).name( 'surface <-> sliders' );
	f.add( ms, 'vertical', 0, 20, 0.5 ).name( 'storey height (m)' );
	f.close();

}

const gPresets = gSurf.addFolder( 'presets' );
let _presetCtrls = [];

function rebuildPresetGui() {

	for ( const c of _presetCtrls ) c.destroy();
	_presetCtrls = [];

	for ( const ms of surfaces ) {

		for ( const p of ms.presets ) {

			const row = { info: `${ms.name}  ${p.x.toFixed( 1 )}, ${p.y.toFixed( 1 )}, ${p.z.toFixed( 1 )}`,
				remove() { ms.remove( p ); rebuildPresetGui(); } };
			_presetCtrls.push( gPresets.add( row, 'info' ).name( p.label ).disable() );
			_presetCtrls.push( gPresets.add( row, 'remove' ).name( '  remove' ) );

		}

	}

}

rebuildPresetGui();
gPresets.close();
gSurf.close();

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
// The post grade lives in the generated Post folder — it is in the parameter
// table, so it is routable, and duplicating it here would be a second slider
// writing the same number with a different range.

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

// Everything in the parameter table, plus the handful of tunables that are not
// in it because they are not a number with a range — booleans, solver internals,
// the odd derived constant. The table half used to be a duplicate list, which
// meant a parameter added to params.js appeared on the panel, became routable and
// placeable, and then quietly did not survive a tuning export. Same table, so it
// cannot drift.
const TUNE_EXTRA = [
	[ 'TUNING', TUNING, [ 'invertY', 'autoLevel', 'cameraLagMax' ] ],
	[ 'SHRED', SHRED, [ 'minLength', 'lifeMin' ] ],
	[ 'HYDRA', HYDRA, [ 'enabled' ] ],
	[ 'solver', solver, [ 'iterations', 'beta', 'alpha', 'gamma', 'postStabilize',
		'sleepTime', 'gravity', 'maxSubsteps', 'maxTravel', 'creepRate' ] ],
	[ 'dust', dust, [ 'densityDecay' ] ]
];

const TUNE_GROUPS = ( () => {

	const byNamespace = new Map();

	for ( const q of PARAMS ) {

		const dot = q.path.indexOf( '.' );
		const ns = q.path.slice( 0, dot );
		if ( ! byNamespace.has( ns ) ) byNamespace.set( ns, [] );
		byNamespace.get( ns ).push( q.path.slice( dot + 1 ) );

	}

	const groups = [];

	for ( const [ ns, keys ] of byNamespace ) {

		const extra = TUNE_EXTRA.find( g => g[ 0 ] === ns );
		groups.push( [ ns, mod.targets[ ns ], extra ? keys.concat( extra[ 2 ] ) : keys ] );

	}

	// Anything with no entry in the table at all.
	for ( const g of TUNE_EXTRA ) if ( ! byNamespace.has( g[ 0 ] ) ) groups.push( g );

	return groups;

} )();

const TUNE_UNIFORMS = [ 'uFogDensity', 'uFogHeightFalloff', 'uVolumetricGain',
	'uCausticStrength', 'uCausticScale', 'uFogColor', 'uAmbient',
	'uWarpAmount', 'uWarpScale', 'uShockThickness' ];

// The base, not the live value, for anything the patch bay is writing. The two
// used to be the same number; now a route lands on the object the export reads,
// so exporting mid-flight would bake whatever the modulation happened to be
// doing at that instant into a line of source claiming to be a default. The
// metasurface capture already reads the base for exactly this reason — a preset
// describes a place, a tuning export describes a build, and neither describes a
// moment.
function readTuning() {

	const out = [];
	const written = new Set( mod.written() );

	for ( const [ label, obj, keys ] of TUNE_GROUPS ) {

		for ( const k of keys ) {

			const path = `${label}.${k}`;
			out.push( [ path, written.has( path ) ? mod.base( path ) : obj[ k ] ] );

		}

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
	healScan() { scan.restore(); },
	clearDebris() {

		accretion.vent();
		shred.clear();
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
gui.add( actions, 'healScan' ).name( 'heal the scan' );
gui.add( actions, 'relight' ).name( 'restore lighting' );

// Everything generated starts collapsed — six folders of sliders opened at once
// is a wall, not an instrument. The patch bay is the exception because it is the
// thing this build is currently about.
for ( const name of FOLDERS ) gParam[ name ].close();
gMod.open();
gRoutes.open();
gPhys.close();
gJoint.close();
gWarp.close();
gDust.close();
gPerf.close();
gLook.close();
let guiOpen = true;

addEventListener( 'keydown', e => {

	if ( e.code === 'Tab' ) {

		e.preventDefault();
		guiOpen = ! guiOpen;
		guiOpen ? gui.open() : gui.close();

	}

	// The readout. A key as well as a checkbox because it is the thing you want
	// while both hands are on the controls and something has just gone wrong.
	if ( e.code === 'KeyM' && ! e.metaKey && ! e.ctrlKey ) {

		readout.show = ! readout.show;
		patchEl.classList.toggle( 'show', readout.show );

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
	// between resuming and exploding. The bound is loose rather than tight
	// because it is not free: everything except the mouse is scaled by dt, so a
	// machine running at 5fps under a hard 0.1 clamp puts the whole world into
	// half speed while the camera, which integrates accumulated pointer delta,
	// keeps turning at full rate. That asymmetry does not read as a low frame
	// rate — it reads as the thrust keys having stopped working.
	if ( dt > 0.25 ) dt = 0.25;
	elapsed += dt;

	governor( dt );

	const state = input.sample();
	state.probe = input.pressed( 'probe' );
	state.vent = input.pressed( 'vent' );
	if ( input.pressed( 'capture' ) ) editor.capture();
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
	strikeBudget = 6;
	shred.update( dt, shredWorld, accretion.disc, shred.onStrike );
	dust.update( dt, flight.viewPosition, flight.velocity );
	if ( VIEW.mode !== 'mesh' ) scan.update( dt );

	rig.uniforms.uTime.value = elapsed;
	rig.update( dt, flight.viewPosition );

	audio.setLoad( Math.min( 1, accretion.watts / ACC.wattScale ) );
	flight.lastImpact *= 0.6;

	camera.position.copy( flight.viewPosition );
	camera.quaternion.copy( flight.viewQuaternion );

	// Assemble what the world knows about itself, then let the patch bay write it
	// into whatever it is routed to.
	{
		const p = flight.viewPosition;
		modState.x = p.x; modState.y = p.y; modState.z = p.z;
		modState.speed = flight.velocity.length();
		modState.burn = !! state.burn;
		modState.saturation = accretion.saturation;
		modState.watts = accretion.watts;
		modState.heat = accretion.heat;
		modState.intake = !! state.intake;
		modState.channelling = accretion.channelling;
		modState.impact = flight.lastImpact;
		modState.light = rig.remaining();
		modState.dilation = dilation;
		// How intact the room is within a few metres — cheap, and it is the only
		// honest way to say "you are standing in what you did".
		modState.intactNear = VIEW.mode !== 'mesh' ? scan.intact( p.x, p.y, p.z, 4.5 ) : 1;

		let near = 1e9;
		for ( let i = 0; i < solver.count; i ++ ) {

			if ( solver.state[ i ] === 0 ) continue;
			const d = Math.hypot( solver.px[ i ] - p.x, solver.py[ i ] - p.y, solver.pz[ i ] - p.z );
			if ( d < near ) near = d;

		}

		modState.proximity = near > 12 ? 0 : 1 - near / 12;
		modState.eatenPulse = eatenPulse;
		eatenPulse *= 0.86;
	}

	mod.update( modState, dt );
	if ( editor.showMarkers ) markers.update( surfaces );

	// Throttled. The breakdown itself is free — the matrix keeps last frame's
	// contributions by name — but rebuilding a few hundred lines of DOM sixty
	// times a second would make the instrument the thing worth measuring.
	if ( readout.show ) {

		readoutClock += dt;
		if ( readoutClock >= 1 / readout.rate ) { readoutClock = 0; drawReadout(); }

	}

	post.update( dt, elapsed, { watts: accretion.watts, heat: accretion.heat, dilation } );

	// Hand the world last frame's composite before drawing this one, along with
	// the matrix that says where each point was when that image was made. The
	// order matters: read first, then render, or the geometry would be sampling a
	// buffer produced from geometry that has already moved.
	if ( VIEW.mode !== 'mesh' ) scan.readFeedback( post.feedback, _prevViewProj, HYDRA.enabled );

	post.render( dt, elapsed );

	camera.updateMatrixWorld();
	_prevViewProj.multiplyMatrices( camera.projectionMatrix, camera.matrixWorldInverse );

	hud.update( dt, {
		locked: input.locked,
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
		mods: mod.enabled ? mod.active( 0.04 ).slice( 0, 4 ).map( m => `${m.name} ${( m.value * 100 ).toFixed( 0 )}` ) : [],
		surfaces: surfaces.flatMap( s => s.influences( 0.03 ).slice( 0, 3 )
			.map( i => `${i.preset.label} ${( i.weight * 100 ).toFixed( 0 )}` ) ),
		scanMode: VIEW.mode,
		scanPoints: scan.drawn,
		scanEroded: scan.eroded,
		shards: shred.live,
		jetRate: accretion.jetRate,
		struck: shred.struck,
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
	scan.uniforms.uPixelRatio.value = quality.dpr;

} );

frame();

// Exposed for console poking during tuning.
window.APPARITION = { solver, rig, flight, accretion, destruction, debris, dust, shred, scan, panels, quality, post,
	TUNING, ACC, POST, SHRED, SCAN, HYDRA, VIEW, mod, surfaces, editor, applyView, copyTuning, readTuning, formatTuning,
	// Patching from the console, for when a folder is faster to type than to find.
	// `patch( 'speed', 'HYDRA.kaleid', 5, 'square' )` appears in the panel like any
	// other route, and `explain( 'HYDRA.feedback' )` is the readout for one path.
	PARAMS, CURVES,
	patch: ( from, to, amount, curve ) => addRouteGui( mod.route( from, to, amount, curve ) ),
	explain: path => mod.explain( path ) };
