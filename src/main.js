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
import { ModMatrix, CURVES, WHEN } from './modulation.js';
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
// about itself is a source. Routes are data, so a look is a list rather than a
// branch in the render loop, and the same mechanism drives the feedback chain,
// the scan and the post grade.

const mod = new ModMatrix( { HYDRA, SCAN, POST, ACC, SHRED } );

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

// A starting patch. Every one of these is a guess to be argued with on the
// panel, which is the point of it being a list.
mod
	// The faster you go, the more the loop drags — this is the one that makes
	// speed feel like something rather than a number.
	.route( 'speed', 'HYDRA.feedback', 0.16, 'square' )
	.route( 'speed', 'HYDRA.zoom', 0.006, 'square' )
	.route( 'burn', 'HYDRA.modAmount', 0.010 )
	// Carrying mass folds the frame. The disc is the resource you watch, so it
	// gets the biggest visual lever in the file.
	// Calibrated by looking. At seven sides a full disc folds the brightest
	// region of the room across the entire frame and the world disappears into a
	// mandala — the route is right, the amount was not. Four is a fold you read
	// as pressure rather than as a takeover, and the panel goes to sixteen.
	.route( 'disc', 'HYDRA.kaleid', 4, 'square' )
	.route( 'disc', 'HYDRA.colorama', 0.02 )
	.route( 'disc', 'HYDRA.saturate', 0.25 )
	.route( 'draw', 'HYDRA.selfModulate', 0.9, 'square' )
	.route( 'draw', 'POST.bloomStrength', 0.35 )
	.route( 'heat', 'HYDRA.shiftR', 0.035 )
	.route( 'heat', 'HYDRA.chromaSplit', 0.004 )
	// Opening the funnel pulls the whole field into it.
	.route( 'intake', 'HYDRA.rotate', 0.055 )
	.route( 'intake', 'HYDRA.modRotateAmount', 0.09 )
	.route( 'channel', 'HYDRA.modScaleAmount', 0.02 )
	.route( 'channel', 'HYDRA.live', 0.30 )
	// Getting hit throws the loop and it takes a beat to settle.
	.route( 'impact', 'HYDRA.modAmount', 0.030, 'root' )
	.route( 'impact', 'HYDRA.invert', 0.35, 'square' )
	.route( 'eaten', 'HYDRA.worldDisplace', 0.9, 'root' )
	// Wrecked ground reads as failing resolution rather than as damage decals —
	// §48's register, driven by the thing it should have been driven by.
	.route( 'ruin', 'HYDRA.pixelate', 90, 'square' )
	.route( 'ruin', 'HYDRA.posterize', 6, 'gate' )
	.route( 'dark', 'HYDRA.thresh', 0.16 )
	.route( 'dark', 'SCAN.glow', 0.5 )
	.route( 'dilation', 'HYDRA.feedback', 0.25 )
	.route( 'dilation', 'HYDRA.modSpeed', - 0.12 )
	.route( 'height', 'HYDRA.colorama', 0.02, 'band' )
	.route( 'proximity', 'HYDRA.repeatX', 2.5, 'square' )
	.route( 'proximity', 'HYDRA.repeatY', 2.5, 'square' );

// Location. Offsets rather than absolutes, feathered, and they sum — so the
// corner where two overlap is a place neither of them describes on its own.
mod
	.zone( 'the pool', { x: 0, y: 0.4, z: 4.2, radius: 5.0, feather: 4.5, set: {
		'HYDRA.colorama': 0.04, 'HYDRA.fieldMix': 0.5, 'HYDRA.modAmount': 0.006,
		'SCAN.rampFloor': - 3.0
	} } )
	.zone( 'the piers', { x: 7.6, y: 2.6, z: - 7.0, radius: 6.0, feather: 5.0, set: {
		'HYDRA.repeatY': 3, 'HYDRA.kaleid': 4, 'HYDRA.rotate': - 0.03
	} } )
	.zone( 'behind the partition', { x: - 8.0, y: 2.8, z: - 3.0, radius: 5.5, feather: 4.0, set: {
		'HYDRA.thresh': 0.22, 'HYDRA.invert': 0.5, 'HYDRA.saturate': - 0.5,
		'SCAN.sparkle': 0.4
	} } );

// --- cues -------------------------------------------------------------------
//
// A scene here has a lighting desk's semantics rather than a VJ bank's: absolute
// levels, a fade-in time, a fade-out time, and a condition that fires it. Two
// ramps rather than one is the whole point — a swell that decays at the speed it
// arrived reads as a switch, and the interesting behaviour is all in the
// asymmetry between how fast something arrives and how long it takes to let go.
//
// Triggers return 0..1 rather than true/false, and `all` is multiplicative, so
// "firing near the pool" comes up half-way when you are half-way into the pool.
// A cue is a gradient in two dimensions at once: how true its condition is, and
// how far along its ramp it has got.

mod
	// The one asked for, more or less verbatim: hold the trigger anywhere near
	// the water and the frame swells over a second and a half, then takes twice
	// as long to let go of it.
	.scene( 'channelling in the pool', {
		when: WHEN.all( WHEN.state( 'channelling' ), WHEN.near( 'the pool' ) ),
		enter: 1.5, exit: 3.4, hold: 0.4,
		set: {
			'HYDRA.saturate': 2.3,
			'HYDRA.colorama': 0.075,
			'HYDRA.kaleid': 8,
			'HYDRA.feedback': 0.86,
			'HYDRA.modRotateAmount': 0.16
		}
	} )

	// Full and still carrying it. Slow in, very slow out — the look of being
	// loaded should outlast the moment you stopped eating.
	.scene( 'overloaded', {
		when: WHEN.above( 'saturation', 0.8, 0.2 ),
		enter: 2.6, exit: 6.0,
		set: {
			'HYDRA.selfModulate': 1.6,
			'HYDRA.modAmount': 0.011,
			'HYDRA.gain': 1.01,
			'SCAN.glow': 1.9
		}
	} )

	// A hit. One frame of trigger, held for a beat so the ramp can arrive at all,
	// then a long release. This is the cue that most needs `hold` — without it the
	// condition is false again before the fade is a tenth of the way up.
	.scene( 'struck', {
		when: WHEN.above( 'impact', 3.0, 2.0 ),
		enter: 0.06, exit: 2.2, hold: 0.35, priority: 10,
		set: {
			'HYDRA.invert': 0.75,
			'HYDRA.chromaSplit': 0.006,
			'HYDRA.thresh': 0.30,
			'HYDRA.rotate': - 0.09
		}
	} )

	// Standing in ground you have destroyed, deep enough that it is not incidental.
	// §48's failing-resolution register, fired by the only thing that should fire it.
	.scene( 'in the ruin', {
		when: WHEN.above( 'ruin', 0.55, 0.25 ),
		enter: 1.8, exit: 4.5,
		set: {
			'HYDRA.pixelate': 220,
			'HYDRA.posterize': 5,
			'HYDRA.saturate': 0.45,
			'HYDRA.colorama': 0.0,
			'SCAN.sparkle': 0.8
		}
	} )

	// Behind the partition, in the dark, with nothing in the disc. The resting
	// look of the place you have not touched yet.
	.scene( 'unlit and empty', {
		when: WHEN.all( WHEN.near( 'behind the partition' ), WHEN.not( WHEN.above( 'saturation', 0.05, 0.1 ) ) ),
		enter: 2.2, exit: 3.0,
		set: {
			'HYDRA.feedback': 0.44,
			'HYDRA.thresh': 0.34,
			'HYDRA.saturate': 0.6,
			'SCAN.lit': 0.06,
			'SCAN.glow': 1.9
		}
	} );

// Cross-modulation. `via` makes a patch local — the same source drives a
// different parameter, or none at all, depending on where you are — and because
// every zone publishes its weight as a source, one region can drive a parameter
// another region owns.
mod
	.route( 'speed', 'HYDRA.kaleid', 5, 'square', 'the piers' )
	.route( 'impact', 'HYDRA.repeatY', 6, 'root', 'the piers' )
	.addSource( 'poolDepth', st => st[ 'zone:the pool' ] || 0, { attack: 0.9, release: 1.8 } )
	.route( 'poolDepth', 'HYDRA.fieldMix', 0.45 )
	.route( 'poolDepth', 'SCAN.rampCeil', - 3.0 );

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
gAcc.add( ACC, 'reach', 2, 24, 0.5 ).name( 'reach (m)' );
gAcc.add( ACC, 'mouthAngle', 0.1, 1.3, 0.01 ).name( 'mouth half-angle' );
gAcc.add( ACC, 'horizon', 0.3, 4, 0.05 ).name( 'event horizon (m)' );
gAcc.add( ACC, 'intake', 0, 500, 5 ).name( 'pull (m/s²)' );
// Third law on the intake. At zero the funnel is a free force; at one, hauling
// on a bench hauls back and the funnel doubles as a movement system.
gAcc.add( ACC, 'reaction', 0, 2, 0.05 ).name( 'reaction (§3.4)' );
gAcc.add( ACC, 'reactionCeiling', 0, 4000, 50 ).name( 'reaction cap (N)' );
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
gAcc.add( ACC, 'fireSpeed', 5, 140, 1 ).name( 'muzzle (m/s)' );
gAcc.add( ACC, 'channelRate', 2, 200, 1 ).name( 'kg/s channelled' );
gAcc.add( ACC, 'streamDensity', 0.1, 4, 0.05 ).name( 'stream density' );
gAcc.add( ACC, 'channelSpread', 0, 0.6, 0.01 ).name( 'jet spread' );
gAcc.add( ACC, 'jetSwirl', 0, 1, 0.01 ).name( 'jet swirl' );
// The visible corkscrew. Costs nothing and, unlike real tangential speed,
// does not walk the stream off whatever you are pointing at.
gAcc.add( ACC, 'jetTwist', 0, 120, 1 ).name( 'jet twist (rad/s)' );
gAcc.add( ACC, 'discOffset', 0, 6, 0.05 ).name( 'disc distance' );
gAcc.add( ACC, 'discRadius', 0.4, 5, 0.05 ).name( 'disc radius' );
gAcc.add( ACC, 'discSpin', 0, 16, 0.1 ).name( 'disc spin' );
gAcc.add( ACC, 'discShards', 0, 1600, 10 ).name( 'disc shards' );
gAcc.add( ACC, 'carryWattsPerKg', 0, 0.2, 0.002 ).name( 'W per kg carried' );
gAcc.add( ACC, 'intakeWattsPerKg', 0, 0.6, 0.005 ).name( 'W per kg·a' );
gAcc.add( accretion, 'selected', {
	tile: MATERIAL_KIND.TILE, concrete: MATERIAL_KIND.CONCRETE,
	glass: MATERIAL_KIND.GLASS, steel: MATERIAL_KIND.STEEL
} ).name( 'firing (wheel)' ).listen();

const gScan = gui.addFolder( 'Scan (point-cloud world)' );
gScan.add( VIEW, 'mode', [ 'mesh', 'scan', 'both' ] ).name( 'world' ).onChange( applyView );
gScan.add( SCAN, 'lod', 0.05, 1, 0.01 ).name( 'density (LOD)' ).listen()
	.onChange( v => scan.setLod( v ) );
gScan.add( SCAN, 'breachAt', 0.02, 0.9, 0.01 ).name( 'breach threshold' );
gScan.add( SCAN, 'pointSize', 0.5, 8, 0.1 ).name( 'point size (px @ 1m)' );
gScan.add( SCAN, 'sizeFalloff', 0, 1.2, 0.02 ).name( 'size falloff' );
gScan.add( SCAN, 'maxPixels', 1, 12, 0.5 ).name( 'max px' );
// Zero is a pure LIDAR diagram, one is the room's own lighting rig on a point
// set. The interesting settings are between, and that is the actual question
// this overlay exists to answer.
gScan.add( SCAN, 'lit', 0, 1, 0.02 ).name( 'ramp <-> rig' );
gScan.add( SCAN, 'glow', 0, 3, 0.05 ).name( 'return glow' );
gScan.add( SCAN, 'fogMix', 0, 1, 0.02 ).name( 'atmosphere on scan' );
gScan.add( SCAN, 'sparkle', 0, 1, 0.02 ).name( 'shimmer' );
gScan.add( SCAN, 'rampFloor', - 4, 4, 0.1 ).name( 'ramp floor (m)' );
gScan.add( SCAN, 'rampCeil', 2, 14, 0.1 ).name( 'ramp ceiling (m)' );
gScan.add( SCAN, 'loosen', 0, 2, 0.02 ).name( 'loosen before drop' );

const gHydra = gui.addFolder( 'Hydra (feedback)' );
gHydra.add( HYDRA, 'enabled' ).name( 'loop on' )
	.onChange( v => { if ( ! v ) post.hydraChain.clear(); } );
// The two that decide whether the loop settles, breathes, or runs away. Above
// about 0.97 feedback with any live injection it never decays and the frame
// fills; hydra's own sketches live right on that edge on purpose.
gHydra.add( HYDRA, 'feedback', 0, 0.995, 0.005 ).name( 'src(o0) survives' );
gHydra.add( HYDRA, 'live', 0, 1.5, 0.02 ).name( 'live injection' );
gHydra.add( HYDRA, 'decay', 0, 0.05, 0.001 ).name( 'bleed to black' );
gHydra.add( HYDRA, 'modAmount', 0, 0.06, 0.0005 ).name( 'modulate' );
gHydra.add( HYDRA, 'modScale', 0.2, 14, 0.1 ).name( 'modulate scale' );
gHydra.add( HYDRA, 'modSpeed', 0, 2, 0.01 ).name( 'modulate speed' );
gHydra.add( HYDRA, 'selfModulate', 0, 3, 0.05 ).name( 'self-modulate' );
gHydra.add( HYDRA, 'fieldMix', 0, 1, 0.02 ).name( 'osc <-> voronoi' );
gHydra.add( HYDRA, 'modScaleAmount', - 0.1, 0.1, 0.002 ).name( 'modulateScale' );
gHydra.add( HYDRA, 'modRotateAmount', - 0.4, 0.4, 0.005 ).name( 'modulateRotate' );
// The biggest single lever in the file. Zero is off; three and up folds the tap
// into that many mirrored wedges and a smear becomes a bloom.
gHydra.add( HYDRA, 'kaleid', 0, 16, 1 ).name( 'kaleid (sides)' );
gHydra.add( HYDRA, 'repeatX', 0, 12, 1 ).name( 'repeat x' );
gHydra.add( HYDRA, 'repeatY', 0, 12, 1 ).name( 'repeat y' );
gHydra.add( HYDRA, 'pixelate', 0, 400, 2 ).name( 'pixelate' );
gHydra.add( HYDRA, 'posterize', 0, 24, 1 ).name( 'posterize' );
gHydra.add( HYDRA, 'thresh', 0, 1, 0.01 ).name( 'thresh' );
gHydra.add( HYDRA, 'invert', 0, 1, 0.02 ).name( 'invert' );
gHydra.add( HYDRA, 'rotate', - 0.4, 0.4, 0.005 ).name( 'rotate / pass' );
gHydra.add( HYDRA, 'zoom', 0.97, 1.03, 0.001 ).name( 'zoom / pass' );
gHydra.add( HYDRA, 'colorama', - 0.15, 0.15, 0.002 ).name( 'colorama' );
gHydra.add( HYDRA, 'saturate', 0, 3, 0.02 ).name( 'saturate' );
gHydra.add( HYDRA, 'chromaSplit', 0, 0.01, 0.0002 ).name( 'chroma split' );
gHydra.add( HYDRA, 'gain', 0.8, 1.3, 0.01 ).name( 'gain' );
// The part that is not a screen filter: the geometry reading the loop back.
gHydra.add( HYDRA, 'worldDisplace', 0, 3, 0.02 ).name( 'world displace (m)' );
gHydra.add( HYDRA, 'worldTint', 0, 2, 0.02 ).name( 'world tint' );

const gMod = gui.addFolder( 'Patch bay' );
gMod.add( mod, 'enabled' ).name( 'modulation on' );
// Any hand-drag has to become the new ground, or the captured base from before
// the drag keeps being restored underneath and the slider appears to snap back.
gMod.add( { rebase() { mod.rebase(); } }, 'rebase' ).name( 'take sliders as base' );

const gScenes = gMod.addFolder( 'scenes (cues)' );
for ( const sc of mod.scenes ) {

	const f = gScenes.addFolder( sc.name );
	f.add( sc, 'on' ).name( 'armed' );
	f.add( sc, 'enter', 0.02, 10, 0.02 ).name( 'fade in (s)' );
	f.add( sc, 'exit', 0.02, 20, 0.05 ).name( 'fade out (s)' );
	f.add( sc, 'hold', 0, 4, 0.05 ).name( 'hold (s)' );
	f.add( sc, 'weight', 0, 1 ).name( 'level' ).listen().disable();
	f.close();

}

const gRoutes = gMod.addFolder( 'routes' );
for ( const r of mod.routes ) {

	const f = gRoutes.addFolder( `${r.from} -> ${r.to.split( '.' )[ 1 ]}` );
	f.add( r, 'on' ).name( 'on' );
	f.add( r, 'amount', - Math.abs( r.amount ) * 4 - 0.001, Math.abs( r.amount ) * 4 + 0.001 ).name( 'amount' );
	f.add( r, 'curve', Object.keys( CURVES ) ).name( 'curve' );
	f.add( { via: r.via || '(everywhere)' }, 'via' ).name( 'only in' ).disable();
	f.close();

}
gRoutes.close();

const gZones = gMod.addFolder( 'zones' );
for ( const z of mod.zones ) {

	const f = gZones.addFolder( z.name );
	f.add( z, 'on' ).name( 'on' );
	f.add( z, 'radius', 0.5, 20, 0.5 ).name( 'radius' );
	f.add( z, 'feather', 0, 15, 0.5 ).name( 'feather' );
	f.close();

}
gZones.close();

const gShred = gui.addFolder( 'Shards' );
// Stretch is the whole look. At zero these are specks; the streak is what makes
// fast debris read as sharp rather than as boxes drifting past.
gShred.add( SHRED, 'stretch', 0, 0.08, 0.001 ).name( 'stretch (m per m/s)' )
	.onChange( v => { shred.uniforms.uStretch.value = v; } );
gShred.add( SHRED, 'maxLength', 0.05, 2, 0.01 ).name( 'max length' )
	.onChange( v => { shred.uniforms.uMaxLength.value = v; } );
gShred.add( SHRED, 'width', 0.002, 0.14, 0.001 ).name( 'width' )
	.onChange( v => { shred.uniforms.uWidth.value = v; } );
// The screen-space floor. Drop it to zero and the field vanishes at range even
// while the readout says a thousand shards a second are leaving.
gShred.add( SHRED, 'minAngular', 0, 0.012, 0.0002 ).name( 'min angular width' )
	.onChange( v => { shred.uniforms.uMinAngular.value = v; } );
gShred.add( SHRED, 'drag', 0, 4, 0.05 ).name( 'drag (1/s)' );
gShred.add( SHRED, 'lifeMax', 0.3, 8, 0.1 ).name( 'life (s)' );
gShred.add( SHRED, 'strikeScale', 0, 0.3, 0.005 ).name( 'cut rate' );
gShred.add( SHRED, 'bounce', 0, 0.9, 0.02 ).name( 'bounce' );

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
	[ 'ACC', ACC, [ 'reach', 'mouthAngle', 'horizon', 'intake', 'reaction', 'reactionCeiling',
		'swirl', 'viscosity', 'axisLag',
		'freeSpeed', 'capacity', 'fireSpeed', 'channelRate', 'streamDensity', 'channelSpread', 'jetSwirl', 'jetTwist',
		'discOffset', 'discRadius', 'discSpin', 'discShards',
		'carryWattsPerKg', 'intakeWattsPerKg' ] ],
	[ 'SHRED', SHRED, [ 'stretch', 'minLength', 'maxLength', 'width', 'minAngular',
		'drag', 'lifeMin', 'lifeMax', 'bounce', 'strikeScale' ] ],
	[ 'solver', solver, [ 'iterations', 'beta', 'alpha', 'gamma', 'postStabilize',
		'sleepTime', 'gravity', 'maxSubsteps', 'maxTravel', 'creepRate' ] ],
	[ 'HYDRA', HYDRA, [ 'feedback', 'live', 'decay', 'modAmount', 'modScale', 'modSpeed',
		'selfModulate', 'fieldMix', 'modScaleAmount', 'modRotateAmount',
		'kaleid', 'repeatX', 'repeatY', 'rotate', 'zoom',
		'colorama', 'saturate', 'chromaSplit', 'pixelate', 'posterize', 'thresh',
		'invert', 'gain', 'worldDisplace', 'worldTint' ] ],
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

// Open, with the lighting folder expanded and the rest collapsed. Lighting is
// the thing you actually want to watch change while you drag it, and a panel you
// have to go find is a panel nobody opens.
gFlight.close();
gCam.close();
gScan.close();
gHydra.close();
gMod.open();
gShred.close();
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
		cues: mod.activeScenes( 0.02 ).map( c => `${c.name} ${( c.weight * 100 ).toFixed( 0 )}` ),
		zone: mod.activeZones().map( z => z.name ).join( ' + ' ),
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
	TUNING, ACC, POST, SHRED, SCAN, HYDRA, VIEW, mod, applyView, copyTuning, readTuning, formatTuning };
